import { expect, test } from "bun:test";
import { ansiCssColor, contrastRatio } from "./ansi-color";

type Rgb = { r: number; g: number; b: number };

// 明るいテーマと暗いテーマの content 地色。補正の基準より広い集合で確かめる。
const LIGHT_BACKGROUNDS: Rgb[] = [
  { r: 0xff, g: 0xff, b: 0xff },
  { r: 0xef, g: 0xf1, b: 0xf5 },
  { r: 0xfd, g: 0xf6, b: 0xe3 },
  { r: 0xfa, g: 0xf4, b: 0xed },
  { r: 0xfa, g: 0xfa, b: 0xfa },
];
const DARK_BACKGROUNDS: Rgb[] = [
  { r: 0x13, g: 0x16, b: 0x19 },
  { r: 0x18, g: 0x19, b: 0x26 },
  { r: 0x1f, g: 0x1f, b: 0x28 },
  { r: 0x2d, g: 0x35, b: 0x3b },
  { r: 0x00, g: 0x21, b: 0x2b },
];

function parse(css: string): Rgb {
  const match = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(css);
  if (match === null) throw new Error(`unexpected color: ${css}`);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function lowestContrast(css: string, backgrounds: Rgb[]): number {
  const color = parse(css);
  return Math.min(...backgrounds.map((background) => contrastRatio(color, background)));
}

test("basic colors use the theme palette", () => {
  expect(ansiCssColor({ kind: "basic", index: 4 }, "light")).toBe("var(--ansi-4)");
  expect(ansiCssColor({ kind: "basic", index: 9 }, "dark")).toBe("var(--ansi-9)");
});

test("a truecolor already readable on the scheme is kept exactly", () => {
  expect(ansiCssColor({ kind: "rgb", r: 0x61, g: 0xaf, b: 0xef }, "dark")).toBe("rgb(97 175 239)");
  expect(ansiCssColor({ kind: "rgb", r: 0x18, g: 0x21, b: 0x2f }, "light")).toBe("rgb(24 33 47)");
});

test("a light terminal foreground on a light theme is darkened to be readable", () => {
  const css = ansiCssColor({ kind: "rgb", r: 0xde, g: 0xe0, b: 0xe1 }, "light");

  expect(css).not.toBe("rgb(222 224 225)");
  expect(lowestContrast(css, LIGHT_BACKGROUNDS)).toBeGreaterThanOrEqual(4.5);
});

test("a dark terminal foreground on a dark theme is lightened to be readable", () => {
  const css = ansiCssColor({ kind: "rgb", r: 0x01, g: 0x02, b: 0x03 }, "dark");

  expect(css).not.toBe("rgb(1 2 3)");
  expect(lowestContrast(css, DARK_BACKGROUNDS)).toBeGreaterThanOrEqual(4.5);
});

test("the correction also handles saturated colors at the extremes", () => {
  const light = ansiCssColor({ kind: "rgb", r: 0xff, g: 0xff, b: 0x00 }, "light");
  const dark = ansiCssColor({ kind: "rgb", r: 0x00, g: 0x00, b: 0xff }, "dark");

  expect(lowestContrast(light, LIGHT_BACKGROUNDS)).toBeGreaterThanOrEqual(4.5);
  expect(lowestContrast(dark, DARK_BACKGROUNDS)).toBeGreaterThanOrEqual(4.5);
});
