// 移植元: u7chan/monorepo の projects/u7agent/client/src/lib/markdown/inline.ts
/**
 * インライン記法 (強調 / コードスパン / リンク / 自動リンク) の解析。
 * 解析できない記法は消さずに literal (原文) へ落とし、例外は投げない。
 */
import type { MdInline } from "./types";

/** エスケープで文字に戻す記号 */
const ESCAPABLE = "\\`*_{}[]()#+-.!~|<>$";

/** 1 回の解析で試す区切りの上限。`*` を大量に含む本文でも O(n^2) に落とさないための保険 */
const MAX_ATTEMPTS = 2000;

/** 強調の対応を探す範囲。離れすぎた閉じは対応させない (探索コストと誤爆を抑える) */
const MAX_EMPHASIS_SPAN = 4096;

/** 入れ子の上限。深い入れ子は原文に落とす (再帰でスタックを食い潰さない) */
const MAX_INLINE_DEPTH = 8;

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

/** 1 段落内で共有する解析の状態 */
type ScanState = { attempts: number };

/** 解析の入口。段落 1 つ分のテキストをインラインノード列にする */
export function parseInline(text: string): MdInline[] {
  return scanInline(text, { attempts: MAX_ATTEMPTS }, 0, true);
}

/** 表示用のテキスト。チェックボックスの名前など、記法を落として読み上げたい場所で使う */
export function inlineText(nodes: MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "literal":
        case "code":
          return node.text;
        case "strong":
        case "em":
        case "del":
        case "link":
          return inlineText(node.children);
        case "break":
          return " ";
      }
    })
    .join("");
}

/** allowLinks=false はリンクのラベル内 (リンクの入れ子を作らない) */
function scanInline(
  text: string,
  state: ScanState,
  depth: number,
  allowLinks: boolean,
): MdInline[] {
  if (depth > MAX_INLINE_DEPTH) return [{ kind: "text", text }];
  const nodes: MdInline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") {
      nodes.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at];
    const escaped = text[at + 1];
    // 末尾の `\` はエスケープする相手が無いので、そのまま本文に残す
    if (char === "\\" && escaped !== undefined && ESCAPABLE.includes(escaped)) {
      buffer += escaped;
      at += 2;
      continue;
    }
    if (char === "\n") {
      flush();
      nodes.push({ kind: "break" });
      at += 1;
      continue;
    }
    if (state.attempts > 0 && char === "`") {
      state.attempts -= 1;
      const span = readCodeSpan(text, at);
      if (span !== null) {
        flush();
        nodes.push({ kind: "code", text: span.text });
        at = span.end;
        continue;
      }
    }
    if (
      state.attempts > 0 &&
      allowLinks &&
      (char === "[" || (char === "!" && text[at + 1] === "["))
    ) {
      state.attempts -= 1;
      const link = readLink(text, at, char === "!", state, depth);
      if (link !== null) {
        flush();
        nodes.push(link.node);
        at = link.end;
        continue;
      }
    }
    if (state.attempts > 0 && char === "<") {
      state.attempts -= 1;
      const angle = readAngle(text, at, allowLinks);
      if (angle !== null) {
        flush();
        nodes.push(angle.node);
        at = angle.end;
        continue;
      }
    }
    if (state.attempts > 0 && (char === "*" || char === "_" || char === "~")) {
      state.attempts -= 1;
      const emphasis = readEmphasis(text, at, state, depth);
      if (emphasis !== null) {
        flush();
        nodes.push(emphasis.node);
        at = emphasis.end;
        continue;
      }
    }
    if (allowLinks && char === "h") {
      const url = readBareUrl(text, at);
      if (url !== null) {
        flush();
        nodes.push(url.node);
        at = url.end;
        continue;
      }
    }
    buffer += char;
    at += 1;
  }
  flush();
  return nodes;
}

/** `` `code` `` / ``` ``code`` ```。対応するバックティックが無ければ null */
function readCodeSpan(text: string, start: number): { text: string; end: number } | null {
  let size = 0;
  while (text[start + size] === "`") size += 1;
  const close = text.indexOf("`".repeat(size), start + size);
  if (close === -1) return null;
  let content = text.slice(start + size, close).replace(/\n/g, " ");
  // 前後に空白があるときだけ 1 つずつ落とす (`` ` x ` `` の慣習)
  if (
    content.length > 2 &&
    content.startsWith(" ") &&
    content.endsWith(" ") &&
    content.trim() !== ""
  ) {
    content = content.slice(1, -1);
  }
  return { text: content, end: close + size };
}

function linkNode(href: string, text: string): MdInline {
  return { kind: "link", href, title: null, children: [{ kind: "text", text }] };
}

/**
 * `<https://…>` / `<mailto:…>` の自動リンク。生 HTML は解釈しないので、
 * 自動リンクでなければ null を返し、`<` はそのまま本文の文字として扱う。
 */
function readAngle(
  text: string,
  start: number,
  allowLinks: boolean,
): { node: MdInline; end: number } | null {
  if (!allowLinks) return null;
  const gt = text.indexOf(">", start + 1);
  if (gt === -1 || gt - start > 2048) return null;
  const inner = text.slice(start + 1, gt);
  if (/^https?:\/\/\S+$/i.test(inner)) return { node: linkNode(inner, inner), end: gt + 1 };
  if (/^mailto:\S+$/i.test(inner)) return { node: linkNode(inner, inner.slice(7)), end: gt + 1 };
  return null;
}

function readEmphasis(
  text: string,
  start: number,
  state: ScanState,
  depth: number,
): { node: MdInline; end: number } | null {
  const char = text[start];
  let run = 0;
  while (text[start + run] === char) run += 1;
  if (char === "~") {
    if (run < 2) return null;
  } else if (run < 1) {
    return null;
  }
  const del = char === "~";
  const strong = !del && run >= 2;
  const size = strong || del ? 2 : 1;
  const after = text[start + size];
  // 開きの直後が空白なら強調にしない (`2 * 3 * 4` を強調にしない)
  if (after === undefined || /\s/.test(after)) return null;
  const strict = char === "_";
  // 語中の _ は対象外 (snake_case を壊さない)
  if (strict && /[0-9A-Za-z]/.test(text[start - 1] ?? "")) return null;
  const close = findClose(text, start + size, char, size, !strict);
  if (close === -1) return null;
  const children = scanInline(text.slice(start + size, close), state, depth + 1, true);
  const node: MdInline = del
    ? { kind: "del", children }
    : strong
      ? { kind: "strong", children }
      : { kind: "em", children };
  return { node, end: close + size };
}

/** 対応する閉じの位置。単独の `*` を数えて `**bold *em* bold**` の入れ子に対応する */
function findClose(
  text: string,
  from: number,
  char: string,
  size: number,
  allowIntraword: boolean,
): number {
  const limit = Math.min(text.length, from + MAX_EMPHASIS_SPAN);
  let depth = 0;
  let at = from;
  while (at < limit) {
    const current = text[at];
    if (current === "\\") {
      at += 2;
      continue;
    }
    if (current === "`") {
      const span = readCodeSpan(text, at);
      at = span === null ? at + 1 : span.end;
      continue;
    }
    if (current !== char) {
      at += 1;
      continue;
    }
    let run = 0;
    while (text[at + run] === char) run += 1;
    const before = text[at - 1];
    const after = text[at + run];
    const closable =
      before !== undefined &&
      !/\s/.test(before) &&
      (allowIntraword || !/[0-9A-Za-z]/.test(after ?? ""));
    if (size === 1) {
      if (run === 1 && closable) return at;
      at += run;
      continue;
    }
    if (depth === 0) {
      if (run >= 2 && closable) return at;
      if (run === 1) depth = 1;
      at += run;
      continue;
    }
    // 内側の `*` が開いているときは 1 つを内側の閉じに、残り 2 つを外側の閉じに使う (`***x***`)
    if (run >= 3) return at + 1;
    if (run === 2) return at;
    depth = 0;
    at += run;
  }
  return -1;
}

/**
 * http / https / mailto だけをリンクにする。相対パスは配信先が無いため通さず、
 * プロトコル相対 (`//host`) も scheme が無いものとして落とす。
 */
function safeUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  // 制御文字・空白・バックスラッシュを含む URL は解釈しない (ブラウザごとの解釈揺れを避ける)
  // oxlint-disable-next-line no-control-regex -- 制御文字を弾くのが目的なので意図どおり
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (scheme === null) return null;
  return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? value : null;
}

function readLink(
  text: string,
  start: number,
  image: boolean,
  state: ScanState,
  depth: number,
): { node: MdInline; end: number } | null {
  const labelStart = image ? start + 2 : start + 1;
  let at = labelStart;
  let nested = 0;
  let labelEnd = -1;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === "[") nested += 1;
    else if (char === "]") {
      if (nested === 0) {
        labelEnd = at;
        break;
      }
      nested -= 1;
    } else if (char === "\n" && text[at + 1] === "\n") break;
    at += 1;
  }
  if (labelEnd === -1 || text[labelEnd + 1] !== "(") return null;
  const end = findDestinationEnd(text, labelEnd + 1);
  if (end === -1) return null;
  const destination = parseDestination(text.slice(labelEnd + 2, end));
  if (destination === null) return null;
  const raw = text.slice(start, end + 1);
  // 画像は表示しない。記法ごと原文を見せ、`!` を落としてリンクに化けさせない
  if (image) return { node: { kind: "literal", text: raw }, end: end + 1 };
  const href = safeUrl(destination.url);
  if (href === null) return { node: { kind: "literal", text: raw }, end: end + 1 };
  const label = text.slice(labelStart, labelEnd);
  return {
    node: {
      kind: "link",
      href,
      title: destination.title,
      children: scanInline(label, state, depth + 1, false),
    },
    end: end + 1,
  };
}

/** `(` から対応する `)` を探す。見つからなければ -1 */
function findDestinationEnd(text: string, open: number): number {
  let at = open;
  let depth = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === "<") {
      const gt = text.indexOf(">", at + 1);
      if (gt === -1) return -1;
      at = gt + 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return at;
    } else if (char === "\n" && text[at + 1] === "\n") return -1;
    at += 1;
  }
  return -1;
}

const DESTINATION = /^\s*(?:<([^<>]*)>|(\S+?))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/;

function parseDestination(inner: string): { url: string; title: string | null } | null {
  const match = DESTINATION.exec(inner);
  if (match === null) return null;
  const url = match[1] ?? match[2] ?? "";
  if (url === "") return null;
  return { url, title: match[3] ?? match[4] ?? match[5] ?? null };
}

/** 裸の URL (直前が語の続きでないときだけ)。文末の句読点はリンクに含めない */
function readBareUrl(text: string, start: number): { node: MdInline; end: number } | null {
  const before = text[start - 1];
  // 語の続きの判定は ASCII に限る (日本語の直後の URL もリンクにする)
  if (before !== undefined && /[0-9A-Za-z_]/.test(before)) return null;
  const match = /^https?:\/\/[^\s<>"）］｝＞」』】》〉〕〗〙〛｣。、！？]+/i.exec(text.slice(start));
  if (match === null) return null;
  let url = match[0].replace(/[.,;:!?]+$/, "");
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  if (url.length < 9) return null;
  return { node: linkNode(url, url), end: start + url.length };
}
