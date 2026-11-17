import { expect, test } from "bun:test";
import {
  THEMES,
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  themeGroups,
  themeScheme,
} from "./theme";

test("every listed theme can be stored as a preference", () => {
  expect(parseThemePreference("system")).toBe("system");
  expect(parseThemePreference(null)).toBe("system");
  expect(parseThemePreference("sepia")).toBe("system");
  expect(THEMES.filter((theme) => parseThemePreference(theme.id) !== theme.id)).toEqual([]);
});

test("the listed themes match the palettes in the stylesheet", async () => {
  const css = await Bun.file("src/client/styles/tokens.css").text();
  // ライトは :root 自体のパレットなので、テーマ別のブロックを持たない。
  const ids = new Set(
    [...css.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]/g)].map((match) => match[1]),
  );
  ids.add("light");

  expect(THEMES.filter((theme) => !ids.has(theme.id))).toEqual([]);
});

// テーマを足すときに必要な色が抜けないよう、各パレットが同じ組を持つことを仕様にする。
const PALETTE_TOKENS = [
  "bg",
  "surface",
  "raised",
  "content",
  "text",
  "secondary",
  "accent",
  "on-accent",
  "selected",
  "line",
  "control-line",
  "active",
  "active-bg",
  "attention",
  "attention-bg",
  "success",
  "success-bg",
  "neutral",
  "neutral-bg",
  "danger",
  "agent-claude",
  "slot-1",
  "slot-2",
  "slot-3",
  "slot-4",
];

test("every palette defines the same colour tokens", async () => {
  const css = await Bun.file("src/client/styles/tokens.css").text();
  const missing: string[] = [];

  for (const theme of THEMES) {
    const selector = theme.id === "light" ? ":root {" : `:root[data-theme="${theme.id}"] {`;
    const start = css.indexOf(selector);
    const block = css.slice(start, css.indexOf("}", start));
    for (const token of PALETTE_TOKENS) {
      if (!block.includes(`--color-${token}:`)) missing.push(`${theme.id}: ${token}`);
    }
  }

  expect(missing).toEqual([]);
});

// 文字色は 4.5:1 を下回らない。--color-muted はテーマ別ではなく明暗 2 系統なので、
// すべての content 背景で確かめる。
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const left = luminance(a);
  const right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function colorValue(block: string, token: string): string | null {
  return new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1] ?? null;
}

test("muted text keeps 4.5:1 on every content background", async () => {
  const css = await Bun.file("src/client/styles/tokens.css").text();
  const light = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const dark = /:root\[data-scheme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const lightMuted = colorValue(light, "muted");
  const darkMuted = colorValue(dark, "muted");
  expect(lightMuted).not.toBeNull();
  expect(darkMuted).not.toBeNull();

  const weak: string[] = [];
  for (const theme of THEMES) {
    const selector = theme.id === "light" ? ":root {" : `:root[data-theme="${theme.id}"] {`;
    const start = css.indexOf(selector);
    const block = css.slice(start, css.indexOf("}", start));
    const content = colorValue(block, "content");
    const muted = theme.scheme === "light" ? lightMuted : darkMuted;
    if (content === null || muted === null) {
      weak.push(`${theme.id}: missing`);
      continue;
    }
    const ratio = contrast(muted, content);
    if (ratio < 4.5) weak.push(`${theme.id}: ${ratio.toFixed(2)}`);
  }

  expect(weak).toEqual([]);
});

// 押下の面に使う accent と、その上の文字 on-accent の組。面の色を変えたときに
// 一緒に動かし忘れないよう、文字の基準を全テーマで見る。
test("on-accent keeps 4.5:1 on every accent background", async () => {
  const css = await Bun.file("src/client/styles/tokens.css").text();
  const weak: string[] = [];
  for (const theme of THEMES) {
    const selector = theme.id === "light" ? ":root {" : `:root[data-theme="${theme.id}"] {`;
    const start = css.indexOf(selector);
    const block = css.slice(start, css.indexOf("}", start));
    const accent = colorValue(block, "accent");
    const onAccent = colorValue(block, "on-accent");
    if (accent === null || onAccent === null) {
      weak.push(`${theme.id}: missing`);
      continue;
    }
    const ratio = contrast(accent, onAccent);
    if (ratio < 4.5) weak.push(`${theme.id}: ${ratio.toFixed(2)}`);
  }

  expect(weak).toEqual([]);
});

test("system follows the device and the rest is fixed", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("nord", false)).toBe("nord");
});

test("every theme knows whether its palette is light or dark", () => {
  expect(themeScheme("dark")).toBe("dark");
  expect(themeScheme("one-light")).toBe("light");
  expect(themeScheme("solarized-dark")).toBe("dark");
  expect(THEMES.every((theme) => themeScheme(theme.id) === theme.scheme)).toBe(true);
});

test("a stored preference is restored", () => {
  const storage = { getItem: (key: string) => (key === "hwc-theme" ? "dark" : null) };
  expect(loadThemePreference(storage)).toBe("dark");
  expect(loadThemePreference({ getItem: () => null })).toBe("system");
  expect(loadThemePreference(null)).toBe("system");
});

test("a storage that refuses to be read falls back to system", () => {
  const storage = {
    getItem: () => {
      throw new Error("blocked");
    },
  };
  expect(loadThemePreference(storage)).toBe("system");
});

test("saving writes the preference and survives a refused write", () => {
  const written: [string, string][] = [];
  const storage = {
    getItem: () => null,
    setItem: (key: string, value: string) => {
      written.push([key, value]);
    },
  };
  saveThemePreference(storage, "dark");
  expect(written).toEqual([["hwc-theme", "dark"]]);

  const blocked = {
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
  };
  expect(() => saveThemePreference(blocked, "light")).not.toThrow();
});

test("the picker lists the brightness modes first, then the palettes by scheme", () => {
  const { modes, light, dark } = themeGroups();

  expect(modes.map((theme) => theme.id)).toEqual(["light", "dark"]);
  expect(light.every((theme) => theme.scheme === "light")).toBe(true);
  expect(dark.every((theme) => theme.scheme === "dark")).toBe(true);
  expect(light.length + dark.length + modes.length).toBe(THEMES.length);
  expect(light.length).toBeGreaterThan(0);
  expect(dark.length).toBeGreaterThan(0);
});
