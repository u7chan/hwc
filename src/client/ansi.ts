export type AnsiColor =
  | { kind: "basic"; index: number }
  | { kind: "rgb"; r: number; g: number; b: number };

export type AnsiStyle = {
  fg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
};

export type AnsiSegment = { text: string; style: AnsiStyle };

export const DEFAULT_ANSI_STYLE: AnsiStyle = {
  fg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
};

// Herdr の `format: "ansi"` は、画面の文字に SGR だけを重ねて返す。制御シーケンスは
// 表示の邪魔になるので落とし、色と装飾だけを残す。背景色と反転は、テーマの地色と
// 組み合わせると読めない組み合わせが作れるため採らない（ADR 0046）。
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style = DEFAULT_ANSI_STYLE;
  let text = "";
  let index = 0;

  const flush = () => {
    if (text === "") return;
    const last = segments[segments.length - 1];
    if (last !== undefined && styleEquals(last.style, style)) {
      segments[segments.length - 1] = { text: last.text + text, style };
    } else {
      segments.push({ text, style });
    }
    text = "";
  };

  while (index < input.length) {
    const char = input[index];
    if (char !== "\u001b") {
      if (isPrintable(char)) text += char;
      index += 1;
      continue;
    }

    const next = input[index + 1];
    if (next === "[") {
      const end = scanCsi(input, index + 2);
      if (end === null) break;
      if (input[end] === "m") {
        flush();
        style = applySgr(style, input.slice(index + 2, end));
      }
      index = end + 1;
      continue;
    }
    if (next === "]") {
      index = skipOsc(input, index + 2);
      continue;
    }
    // ESC の 2 文字シーケンス。次の 1 文字だけ捨てる。
    index += next === undefined ? 1 : 2;
  }

  flush();
  return segments;
}

function isPrintable(char: string): boolean {
  if (char === "\n" || char === "\t") return true;
  const code = char.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f);
}

// パラメータと中間バイトを読み、最後の文字の位置を返す。途中で切れたときは null。
function scanCsi(input: string, start: number): number | null {
  let index = start;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
      index += 1;
      continue;
    }
    if (code >= 0x40 && code <= 0x7e) return index;
    // 制御シーケンスの形になっていない。ESC と [ だけを捨てて本文に戻る。
    return index - 1;
  }
  return null;
}

function skipOsc(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    if (input[index] === "\u0007") return index + 1;
    if (input[index] === "\u001b" && input[index + 1] === "\\") return index + 2;
    index += 1;
  }
  return input.length;
}

function applySgr(style: AnsiStyle, raw: string): AnsiStyle {
  const params = (raw === "" ? "0" : raw).split(";");
  let next = style;
  const update = (patch: Partial<AnsiStyle>) => {
    next = { ...next, ...patch };
  };

  for (let index = 0; index < params.length; index += 1) {
    const code = parseCode(params[index]);
    if (code === null) continue;

    switch (code) {
      case 0:
        next = DEFAULT_ANSI_STYLE;
        break;
      case 1:
        update({ bold: true });
        break;
      case 2:
        update({ dim: true });
        break;
      case 3:
        update({ italic: true });
        break;
      case 4:
        update({ underline: true });
        break;
      case 9:
        update({ strike: true });
        break;
      case 21:
        update({ bold: false });
        break;
      case 22:
        update({ bold: false, dim: false });
        break;
      case 23:
        update({ italic: false });
        break;
      case 24:
        update({ underline: false });
        break;
      case 29:
        update({ strike: false });
        break;
      case 38: {
        const extended = readExtendedColor(params, index);
        if (extended !== null) {
          update({ fg: extended.color });
          index = extended.next;
        }
        break;
      }
      case 48: {
        const extended = readExtendedColor(params, index);
        if (extended !== null) index = extended.next;
        break;
      }
      case 39:
        update({ fg: null });
        break;
      default:
        if (code >= 30 && code <= 37) update({ fg: basicColor(code - 30) });
        else if (code >= 90 && code <= 97) update({ fg: basicColor(code - 90 + 8) });
        break;
    }
  }

  return next;
}

function parseCode(part: string | undefined): number | null {
  if (part === undefined) return null;
  if (part === "") return 0;
  const value = Number(part);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function basicColor(index: number): AnsiColor {
  return { kind: "basic", index };
}

function readExtendedColor(
  params: string[],
  start: number,
): { color: AnsiColor; next: number } | null {
  const mode = parseCode(params[start + 1]);
  if (mode === 5) {
    const value = parseCode(params[start + 2]);
    if (value === null || value > 255) return null;
    return { color: colorFrom256(value), next: start + 2 };
  }
  if (mode === 2) {
    const r = parseCode(params[start + 2]);
    const g = parseCode(params[start + 3]);
    const b = parseCode(params[start + 4]);
    if (r === null || g === null || b === null || r > 255 || g > 255 || b > 255) return null;
    return { color: { kind: "rgb", r, g, b }, next: start + 4 };
  }
  return null;
}

function colorFrom256(value: number): AnsiColor {
  if (value < 16) return basicColor(value);
  if (value < 232) {
    const index = value - 16;
    const r = Math.floor(index / 36);
    const g = Math.floor((index % 36) / 6);
    const b = index % 6;
    const level = (part: number) => (part === 0 ? 0 : 55 + part * 40);
    return { kind: "rgb", r: level(r), g: level(g), b: level(b) };
  }
  const gray = 8 + (value - 232) * 10;
  return { kind: "rgb", r: gray, g: gray, b: gray };
}

function styleEquals(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    colorEquals(a.fg, b.fg)
  );
}

function colorEquals(a: AnsiColor | null, b: AnsiColor | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "basic" && b.kind === "basic") return a.index === b.index;
  if (a.kind === "rgb" && b.kind === "rgb") return a.r === b.r && a.g === b.g && a.b === b.b;
  return false;
}
