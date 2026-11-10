// 移植元: u7chan/monorepo の projects/u7agent/client/src/lib/markdown/parse.ts
/**
 * ブロック (見出し / 段落 / リスト / 引用 / 表 / コードフェンス) の行スキャナ。
 * 例外は投げず、解釈できない行は段落 (原文) として扱う。
 */
import { parseInline } from "./inline";
import type { MdAlign, MdBlock, MdHeadingLevel, MdInline, MdListItem } from "./types";

/** これを超える本文は解析せずプレーン表示に落とす */
export const MARKDOWN_MAX_LENGTH = 200 * 1024;

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const DELIMITER_CELL = /^:?-+:?$/;

export function parseMarkdown(text: string): MdBlock[] {
  // CRLF / CR のみの改行も行境界として扱う
  return parseLines(text.replace(/\r\n?/g, "\n").split("\n"));
}

// 描画側が実際に image ノードにした destination を集める。BFF の表記の照合だけで
// 判定すると、フェンスの中や解析上限の外の記法まで「描いた」ことにしてしまう。
export function markdownImageHrefs(text: string): Set<string> {
  const hrefs = new Set<string>();
  if (text.length > MARKDOWN_MAX_LENGTH) return hrefs;
  collectImageHrefs(parseMarkdown(text), hrefs);
  return hrefs;
}

function collectImageHrefs(blocks: readonly MdBlock[], hrefs: Set<string>): void {
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
      case "paragraph":
        collectInlineImageHrefs(block.source, hrefs);
        break;
      case "quote":
        // 引用とリスト項目は描画側と同じく、内側の本文をもう一度解析する。
        collectImageHrefs(parseMarkdown(block.source), hrefs);
        break;
      case "list":
        for (const item of block.items) collectImageHrefs(parseMarkdown(item.source), hrefs);
        break;
      case "table":
        for (const cell of block.header) collectInlineImageHrefs(cell, hrefs);
        for (const row of block.rows) for (const cell of row) collectInlineImageHrefs(cell, hrefs);
        break;
      case "code":
      case "hr":
        break;
    }
  }
}

function collectInlineImageHrefs(source: string, hrefs: Set<string>): void {
  for (const node of parseInline(source)) collectInlineNode(node, hrefs);
}

function collectInlineNode(node: MdInline, hrefs: Set<string>): void {
  if (node.kind === "image") {
    hrefs.add(node.href);
    return;
  }
  if (node.kind === "strong" || node.kind === "em" || node.kind === "del" || node.kind === "link") {
    for (const child of node.children) collectInlineNode(child, hrefs);
  }
}

function parseLines(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (isBlank(line)) {
      at += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const result = readFence(lines, at, fence);
      blocks.push(result.block);
      at = result.next;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as MdHeadingLevel,
        source: heading[2] ?? "",
      });
      at += 1;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      at += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const result = readQuote(lines, at);
      blocks.push(result.block);
      at = result.next;
      continue;
    }
    const list = LIST_MARKER.exec(line);
    if (list !== null) {
      const result = readList(lines, at, list);
      blocks.push(result.block);
      at = result.next;
      continue;
    }
    const table = readTable(lines, at);
    if (table !== null) {
      blocks.push(table.block);
      at = table.next;
      continue;
    }
    const result = readParagraph(lines, at);
    blocks.push(result.block);
    at = result.next;
  }
  return blocks;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function nextNonBlank(lines: string[], from: number): number {
  for (let at = from; at < lines.length; at += 1) {
    if (!isBlank(lines[at])) return at;
  }
  return -1;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** 段落を中断する行 (これ以外の行は段落の続きとして連結する) */
function startsBlock(lines: string[], at: number): boolean {
  const line = lines[at];
  if (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_MARKER.test(line)
  ) {
    return true;
  }
  return isTableStart(lines, at);
}

function readParagraph(lines: string[], start: number): { block: MdBlock; next: number } {
  const parts = [lines[start].trim()];
  let at = start + 1;
  while (at < lines.length && !isBlank(lines[at]) && !startsBlock(lines, at)) {
    parts.push(lines[at].trim());
    at += 1;
  }
  return { block: { kind: "paragraph", source: parts.join("\n") }, next: at };
}

function readQuote(lines: string[], start: number): { block: MdBlock; next: number } {
  const parts: string[] = [];
  let at = start;
  while (at < lines.length) {
    const match = QUOTE.exec(lines[at]);
    if (match === null) break;
    parts.push(match[1]);
    at += 1;
  }
  return { block: { kind: "quote", source: parts.join("\n") }, next: at };
}

function readFence(
  lines: string[],
  start: number,
  fence: RegExpExecArray,
): { block: MdBlock; next: number } {
  const marker = fence[1];
  const info = fence[2].trim();
  const lang = info === "" ? null : info.split(/[ \t]+/)[0];
  const content: string[] = [];
  let at = start + 1;
  let closed = false;
  while (at < lines.length) {
    const close = FENCE_CLOSE.exec(lines[at]);
    if (close !== null && close[1][0] === marker[0] && close[1].length >= marker.length) {
      closed = true;
      at += 1;
      break;
    }
    content.push(lines[at]);
    at += 1;
  }
  return { block: { kind: "code", lang, text: content.join("\n"), closed }, next: at };
}

function readList(
  lines: string[],
  start: number,
  first: RegExpExecArray,
): { block: MdBlock; next: number } {
  const baseIndent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: MdListItem[] = [];
  let at = start;
  while (at < lines.length) {
    // 項目間の空行は同じリストの続きとして読み飛ばす
    if (isBlank(lines[at])) {
      const next = nextNonBlank(lines, at);
      if (next === -1 || !isSiblingMarker(lines[next], baseIndent, ordered)) break;
      at = next;
      continue;
    }
    const marker = LIST_MARKER.exec(lines[at]);
    if (marker === null || marker[1].length !== baseIndent || /^\d/.test(marker[2]) !== ordered)
      break;
    const contentIndent = baseIndent + marker[2].length + Math.max(1, marker[3].length);
    const raw = [lines[at].slice(baseIndent + marker[2].length).replace(/^[ \t]+/, "")];
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(raw[0]);
    if (task !== null) raw[0] = raw[0].slice(task[0].length);
    let scan = at + 1;
    while (scan < lines.length) {
      if (isBlank(lines[scan])) {
        const next = nextNonBlank(lines, scan);
        if (next === -1 || indentOf(lines[next]) <= baseIndent) break;
        // フェンス前後の空行を落とさないよう、詰めずに残す
        for (let blank = scan; blank < next; blank += 1) raw.push("");
        scan = next;
        continue;
      }
      const indent = indentOf(lines[scan]);
      // インデントされていない行は項目の外 (遅延継続は対象外)
      if (indent <= baseIndent) break;
      raw.push(lines[scan].slice(Math.min(contentIndent, indent)));
      scan += 1;
    }
    items.push({
      source: raw.join("\n").replace(/\n+$/, ""),
      ...(task === null ? {} : { task: task[1].toLowerCase() === "x" }),
    });
    at = scan;
  }
  return { block: { kind: "list", ordered, start: startNumber, items }, next: at };
}

function isSiblingMarker(line: string, baseIndent: number, ordered: boolean): boolean {
  const marker = LIST_MARKER.exec(line);
  return marker !== null && marker[1].length === baseIndent && /^\d/.test(marker[2]) === ordered;
}

function isTableStart(lines: string[], at: number): boolean {
  if (at + 1 >= lines.length || !lines[at].includes("|")) return false;
  const header = splitRow(lines[at]);
  const delimiter = splitRow(lines[at + 1]);
  return (
    header.length > 0 &&
    delimiter.length === header.length &&
    delimiter.every((cell) => DELIMITER_CELL.test(cell))
  );
}

function readTable(lines: string[], start: number): { block: MdBlock; next: number } | null {
  if (!isTableStart(lines, start)) return null;
  const header = splitRow(lines[start]);
  const delimiter = splitRow(lines[start + 1]);
  const align: MdAlign[] = delimiter.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
  const rows: string[][] = [];
  let at = start + 2;
  while (at < lines.length && !isBlank(lines[at]) && lines[at].includes("|")) {
    const cells = splitRow(lines[at]);
    rows.push(header.map((_, index) => cells[index] ?? ""));
    at += 1;
  }
  return { block: { kind: "table", align, header, rows }, next: at };
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at];
    if (char === "\\" && body[at + 1] === "|") {
      cell += "|";
      at += 1;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
