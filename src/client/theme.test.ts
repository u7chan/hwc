import { expect, test } from "bun:test";
import {
  THEMES,
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  themeGroups,
} from "./theme";

test("every listed theme can be stored as a preference", () => {
  expect(parseThemePreference("light")).toBe("light");
  expect(parseThemePreference("dark")).toBe("dark");
  expect(parseThemePreference("nord")).toBe("nord");
  expect(parseThemePreference("catppuccin-mocha")).toBe("catppuccin-mocha");
  expect(parseThemePreference("system")).toBe("system");
  expect(parseThemePreference(null)).toBe("system");
  expect(parseThemePreference("sepia")).toBe("system");
});

test("the listed themes match the palettes in the stylesheet", async () => {
  const css = await Bun.file("src/client/styles.css").text();
  // ライトは :root 自体のパレットなので、テーマ別のブロックを持たない。
  const ids = new Set(
    [...css.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]/g)].map((match) => match[1]),
  );
  ids.add("light");

  expect(THEMES.filter((theme) => !ids.has(theme.id))).toEqual([]);
});

test("system follows the device and the rest is fixed", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("nord", false)).toBe("nord");
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
