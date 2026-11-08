import { expect, test } from "bun:test";
import { DEFAULT_ANSI_STYLE, parseAnsi, type AnsiStyle } from "./ansi";

function style(patch: Partial<AnsiStyle>): AnsiStyle {
  return { ...DEFAULT_ANSI_STYLE, ...patch };
}

test("plain text stays one segment", () => {
  expect(parseAnsi("hello\nworld")).toEqual([{ text: "hello\nworld", style: DEFAULT_ANSI_STYLE }]);
});

test("basic foreground colors use the 0-7 palette", () => {
  expect(parseAnsi("\u001b[31mred\u001b[0m")).toEqual([
    { text: "red", style: style({ fg: { kind: "basic", index: 1 } }) },
  ]);
});

test("bright foreground colors use the 8-15 palette", () => {
  expect(parseAnsi("\u001b[92mgreen")).toEqual([
    { text: "green", style: style({ fg: { kind: "basic", index: 10 } }) },
  ]);
});

test("decorations turn on and off independently", () => {
  expect(parseAnsi("\u001b[1;2;3;4;9mstyled")).toEqual([
    {
      text: "styled",
      style: style({ bold: true, dim: true, italic: true, underline: true, strike: true }),
    },
  ]);
  expect(parseAnsi("\u001b[1;4mstyled\u001b[22;24mplain")).toEqual([
    { text: "styled", style: style({ bold: true, underline: true }) },
    { text: "plain", style: DEFAULT_ANSI_STYLE },
  ]);
});

test("a color survives a decoration reset", () => {
  expect(parseAnsi("\u001b[31;1mred\u001b[22m still red")).toEqual([
    { text: "red", style: style({ fg: { kind: "basic", index: 1 }, bold: true }) },
    { text: " still red", style: style({ fg: { kind: "basic", index: 1 } }) },
  ]);
});

test("39 restores the default foreground", () => {
  expect(parseAnsi("\u001b[31mred\u001b[39mplain")).toEqual([
    { text: "red", style: style({ fg: { kind: "basic", index: 1 } }) },
    { text: "plain", style: DEFAULT_ANSI_STYLE },
  ]);
});

test("256-color indexes map to the basic, cube, and gray palettes", () => {
  const color = (code: string) => {
    const [segment] = parseAnsi(`\u001b[38;5;${code}mtext`);
    return segment?.style.fg;
  };

  expect(color("9")).toEqual({ kind: "basic", index: 9 });
  expect(color("196")).toEqual({ kind: "rgb", r: 255, g: 0, b: 0 });
  expect(color("232")).toEqual({ kind: "rgb", r: 8, g: 8, b: 8 });
  expect(color("255")).toEqual({ kind: "rgb", r: 238, g: 238, b: 238 });
});

test("24-bit colors keep their exact values", () => {
  expect(parseAnsi("\u001b[38;2;1;2;3mrgb")).toEqual([
    { text: "rgb", style: style({ fg: { kind: "rgb", r: 1, g: 2, b: 3 } }) },
  ]);
});

test("unknown SGR codes are ignored", () => {
  expect(parseAnsi("\u001b[5;7;8;53mtext")).toEqual([{ text: "text", style: DEFAULT_ANSI_STYLE }]);
});

test("non-SGR control sequences are dropped", () => {
  expect(parseAnsi("a\u001b[2Kb\u001b[?25lc")).toEqual([
    { text: "abc", style: DEFAULT_ANSI_STYLE },
  ]);
});

test("OSC sequences are dropped without leaving their payload", () => {
  expect(parseAnsi("a\u001b]8;;http://example.com\u0007b\u001b]8;;\u001b\\c")).toEqual([
    { text: "abc", style: DEFAULT_ANSI_STYLE },
  ]);
});

test("control characters other than newline and tab are dropped", () => {
  expect(parseAnsi("a\rb\bc\u0000d\u007fe\tf\ng")).toEqual([
    { text: "abcde\tf\ng", style: DEFAULT_ANSI_STYLE },
  ]);
});

test("an escape sequence cut off at the end is dropped", () => {
  expect(parseAnsi("text\u001b[31")).toEqual([{ text: "text", style: DEFAULT_ANSI_STYLE }]);
});

test("a broken sequence stops at the next printable character", () => {
  expect(parseAnsi("a\u001b[31\nb")).toEqual([{ text: "a\nb", style: DEFAULT_ANSI_STYLE }]);
});

test("adjacent runs with the same style are merged", () => {
  expect(parseAnsi("\u001b[31mred\u001b[31mstill red\u001b[0m")).toEqual([
    { text: "redstill red", style: style({ fg: { kind: "basic", index: 1 } }) },
  ]);
});
