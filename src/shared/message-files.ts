import { attachmentContentTypeFromName } from "./attachments";

// エージェントの本文に書かれたファイルをどう見せるか。画像はサムネイル、HTML は
// プレビュー。配信できる形式と型の対応はここだけで持つ（ADR 0051）。

export type MessageFileKind = "image" | "html";

// HTML のプレビューが読み込む副次ファイル。html と同じ場所に置かれた css / js / 画像を
// 相対参照で解決させるために、この一覧だけを配信する。画像の 3 形式は添付の表から引く。
const CONTENT_TYPE_BY_EXT: ReadonlyMap<string, string> = new Map([
  ["html", "text/html; charset=utf-8"],
  ["htm", "text/html; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["gif", "image/gif"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isHtmlName(name: string): boolean {
  const ext = extOf(name);
  return ext === "html" || ext === "htm";
}

// 画像の判定は添付と同じ表に任せる。allowlist を 2 か所に分けない。
export function messageFileKindFromName(name: string): MessageFileKind | null {
  if (attachmentContentTypeFromName(name) !== null) return "image";
  return isHtmlName(name) ? "html" : null;
}

// プレビューで配信してよい形式だけ型を返す。ここに無い拡張子は配信しない。
export function previewContentType(name: string): string | null {
  return attachmentContentTypeFromName(name) ?? CONTENT_TYPE_BY_EXT.get(extOf(name)) ?? null;
}

// 画面に出す名前。パスではなくファイル名だけを出し、パスは読み上げと title に回す。
export function messageFileLabel(name: string): string {
  const index = name.lastIndexOf("/");
  return index < 0 ? name : name.slice(index + 1);
}
