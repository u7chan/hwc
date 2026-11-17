import { highlightCode, normalizeLang, type Token } from "./highlight";

// トークン 1 つが DOM ノード 1 つになる。スマホでスクロールが重くならないよう、
// 色付けはこの数で打ち切る。超えたら本文と行番号だけのプレーン表示に戻す（ADR 0092）。
export const PREVIEW_HIGHLIGHT_MAX_TOKENS = 20_000;

export function normalizePreviewText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// 拡張子から言語を決める。拡張子を持たない Dockerfile だけ bash の規則で色を付ける。
export function previewLang(path: string): string | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot > 0) return normalizeLang(name.slice(dot + 1));
  return name === "dockerfile" ? "bash" : null;
}

// 色付けするときだけトークン列を作る。判定できないファイルと上限超過は null で、
// 呼び出し側は本文をそのまま出す。
export function previewTokens(text: string, path: string): Token[] | null {
  const lang = previewLang(path);
  if (lang === null) return null;
  return highlightCode(text, lang, PREVIEW_HIGHLIGHT_MAX_TOKENS);
}

// 末尾の改行は最後の行を終えるだけなので、行番号を増やさない。
export function previewLineNumbers(text: string): string {
  if (text === "") return "";
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (index === text.length - 1) continue;
    count += 1;
  }
  const numbers: string[] = [];
  for (let number = 1; number <= count; number += 1) numbers.push(String(number));
  return numbers.join("\n");
}
