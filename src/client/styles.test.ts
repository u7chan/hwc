import { expect, test } from "bun:test";

const tokens = await Bun.file("src/client/styles/tokens.css").text();
const app = await Bun.file("src/client/styles/app.css").text();
// 2 ファイルは同じページに読み込まれる。解決と接頭辞は全体で見る。
const css = `${tokens}\n${app}`;

// 素の値と役割トークンが混ざると、同じ意図の値が少しずつずれる。機械で見張れる範囲はここで止める。
const SPACING_SCALE = new Set([
  "4px",
  "8px",
  "12px",
  "16px",
  "20px",
  "24px",
  "32px",
  "40px",
  "48px",
]);
const RADIUS_SCALE = new Set(["8px", "10px", "12px", "16px", "24px"]);

// パレットは tokens.css の :root とテーマ別の :root[...] にだけ書く。
function paletteBlocks(text: string): string[] {
  return [...text.matchAll(/:root[^{]*\{[^}]*\}/g)].map((match) => match[0]);
}

function declarations(text: string, properties: RegExp): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => properties.test(line));
}

test("every var() reference resolves to a declared token", () => {
  const declared = new Set([...css.matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((match) => match[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
  const missing = [...used].filter((name) => !declared.has(name));

  expect(missing).toEqual([]);
});

test("colors are literals only inside the token palettes", () => {
  const palettes = paletteBlocks(tokens);
  let rest = tokens;
  for (const block of palettes) rest = rest.replace(block, "");
  const pattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;
  const literals = [
    ...[...rest.matchAll(pattern)].map((match) => match[0]),
    ...[...app.matchAll(pattern)].map((match) => match[0]),
  ];

  expect(literals).toEqual([]);
  expect(palettes.length).toBeGreaterThan(1);
  expect(palettes[0]).toContain("--color-accent:");
  expect(palettes[1]).toContain("--color-accent:");
});

test("spacing and radius come from the tokens", () => {
  const spacing = declarations(app, /^(padding|margin|gap|row-gap|column-gap)[a-z-]*:/).filter(
    (line) => {
      const values = line.match(/\b\d+px\b/g) ?? [];
      return values.some((value) => SPACING_SCALE.has(value));
    },
  );
  const radius = declarations(app, /^border(-[a-z]+)*-radius:/).filter((line) => {
    const values = line.match(/\b\d+px\b/g) ?? [];
    return values.some((value) => RADIUS_SCALE.has(value));
  });

  expect([...spacing, ...radius]).toEqual([]);
});

test("selectors keep the hwc- prefix", () => {
  const names = [...css.matchAll(/^\s*\.([a-zA-Z][\w-]*)/gm)].map((match) => match[1]);
  const unprefixed = [...new Set(names)].filter((name) => !name.startsWith("hwc-"));

  expect(unprefixed).toEqual([]);
});

test("classes used by the client keep the hwc- prefix", async () => {
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("src/client/**/*.tsx").scan(".")) {
    const text = await Bun.file(file).text();
    for (const match of text.matchAll(/class=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      for (const name of (match[1] ?? match[2] ?? "").split(/\s+/).filter(Boolean)) {
        if (!name.startsWith("hwc-")) offenders.push(`${file}: ${name}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});

// アイコンの豆腐は、欠けても気づきにくい。CSS と同梱物の対応をここで固定する。
const SYMBOLS_FACE = tokens.match(/@font-face\s*\{[^}]*Nerd Symbols Mono[^}]*\}/)?.[0] ?? "";

function unicodeRangeCovers(range: string, codepoint: number): boolean {
  return range.split(",").some((part) => {
    const [from, to] = part.trim().replace(/^U\+/i, "").split("-");
    const start = Number.parseInt(from, 16);
    const end = to === undefined ? start : Number.parseInt(to, 16);
    return codepoint >= start && codepoint <= end;
  });
}

test("the nerd symbols font backs the mono stack", () => {
  const family = /font-family:\s*"([^"]+)"/.exec(SYMBOLS_FACE)?.[1];
  const stack = /--font-mono:\s*([^;]+);/.exec(tokens)?.[1] ?? "";

  expect(family).toBeDefined();
  expect(stack).toContain(`"${family}"`);
  // generic monospace より前でないと、フォールバックの解決で拾われない。
  expect(stack.indexOf(`"${family}"`)).toBeLessThan(stack.lastIndexOf("monospace"));
});

// 報告のあった U+E60B / U+E672 / U+F418 が漏れると、その行だけ豆腐に戻る。
test("the nerd symbols font covers the codepoints Herdr emits", () => {
  const range = /unicode-range:\s*([^;]+);/.exec(SYMBOLS_FACE)?.[1] ?? "";

  for (const codepoint of [0xe60b, 0xe672, 0xf418, 0xe0b0]) {
    expect(unicodeRangeCovers(range, codepoint)).toBe(true);
  }
});

// 範囲は CSS とフォントの作り方の両方に書く。片方だけ直すと、豆腐が戻るか無駄な取得が増える。
function normaliseRanges(range: string): string[] {
  return range
    .split(",")
    .map((part) => part.trim().replace(/^U\+/i, "").toLowerCase())
    .sort();
}

test("the stylesheet and the font recipe cover the same codepoints", async () => {
  const notice = await Bun.file("src/client/assets/fonts/NOTICE.md").text();
  const recipe = /--unicodes="([^"]+)"/.exec(notice)?.[1] ?? "";
  const range = /unicode-range:\s*([^;]+);/.exec(SYMBOLS_FACE)?.[1] ?? "";

  expect(recipe).not.toBe("");
  expect(normaliseRanges(range)).toEqual(normaliseRanges(recipe));
});

test("the nerd symbols font file exists where the stylesheet points", async () => {
  const url = /url\("([^"]+)"\)/.exec(SYMBOLS_FACE)?.[1] ?? "";
  const path = `src/client/styles/${url}`;

  expect(url).toEndWith(".woff2");
  expect(await Bun.file(path).exists()).toBe(true);
});
