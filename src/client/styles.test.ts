import { expect, test } from "bun:test";

const css = await Bun.file("src/client/styles.css").text();

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

// パレットは :root とテーマ別の :root[...] にだけ書く。
function paletteBlocks(): string[] {
  return [...css.matchAll(/:root[^{]*\{[^}]*\}/g)].map((match) => match[0]);
}

function declarations(properties: RegExp): string[] {
  return css
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

test("colors are literals only inside the palette blocks", () => {
  const palettes = paletteBlocks();
  let rest = css;
  for (const block of palettes) rest = rest.replace(block, "");
  const literals = [...rest.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)].map(
    (match) => match[0],
  );

  expect(literals).toEqual([]);
  expect(palettes.length).toBeGreaterThan(1);
  expect(palettes[0]).toContain("--color-accent:");
  expect(palettes[1]).toContain("--color-accent:");
});

test("spacing and radius come from the tokens", () => {
  const spacing = declarations(/^(padding|margin|gap|row-gap|column-gap)[a-z-]*:/).filter(
    (line) => {
      const values = line.match(/\b\d+px\b/g) ?? [];
      return values.some((value) => SPACING_SCALE.has(value));
    },
  );
  const radius = declarations(/^border(-[a-z]+)*-radius:/).filter((line) => {
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
