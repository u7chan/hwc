import type { AnsiSegment, AnsiStyle } from "./ansi";

export type OutputPart =
  | { kind: "text"; text: string; style: AnsiStyle }
  | { kind: "link"; text: string; href: string; style: AnsiStyle };

// 出力は任意のプログラムの文字列で、言語は決まらない。端末が付けた色はそのまま残し、
// 裸の URL だけをリンクにする。ホストは読み替えない（ADR 0046）。
export function linkify(segments: readonly AnsiSegment[]): OutputPart[] {
  const parts: OutputPart[] = [];

  for (const segment of segments) {
    const pattern = /https?:\/\/[^\s<>"'`、。，．…！？：；]+/gi;
    let cursor = 0;

    for (;;) {
      const match = pattern.exec(segment.text);
      if (match === null) break;

      const start = match.index;
      const url = trimTrailing(match[0]);
      const href = httpHref(url);
      if (url === "" || href === null) continue;

      if (start > cursor) {
        parts.push({
          kind: "text",
          text: segment.text.slice(cursor, start),
          style: segment.style,
        });
      }
      parts.push({ kind: "link", text: url, href, style: segment.style });
      cursor = start + url.length;
    }

    if (cursor < segment.text.length) {
      parts.push({ kind: "text", text: segment.text.slice(cursor), style: segment.style });
    }
  }

  return parts;
}

// URL の直後の句読点と、対応の取れていない閉じ括弧を落とす。`(http://… )` の外側や、
// `http://localhost:30000 (515d9d5)` の括弧を URL に含めないため。和文の句読点と
// 全角の括弧も、端末出力では本文の一部として続くことがある。
const TRAILING = ".,;:!?。、，．…！？：；";
const CLOSING: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
  "）": "（",
  "］": "［",
  "｝": "｛",
  "】": "【",
  "」": "「",
  "』": "『",
  "》": "《",
  "〉": "〈",
};

function trimTrailing(raw: string): string {
  let end = raw.length;

  for (;;) {
    const before = end;
    while (end > 0 && TRAILING.includes(raw[end - 1])) end -= 1;

    while (end > 0) {
      const last = raw[end - 1];
      const open = CLOSING[last];
      if (open === undefined) break;
      const opened = countChar(raw.slice(0, end), open);
      const closed = countChar(raw.slice(0, end), last);
      if (closed <= opened) break;
      end -= 1;
    }

    if (end === before) break;
  }

  return raw.slice(0, end);
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const item of text) {
    if (item === char) count += 1;
  }
  return count;
}

function httpHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
