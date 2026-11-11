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

// プレビューで配信できない参照を含む HTML の案内。値はそのまま応答ヘッダーと
// クライアントの分岐に使うので、増やすときは両方を合わせる。
export type PreviewWarning = "script";

// 外部のスクリプトは hwc が配信していないので判断しない。
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isDeliverableScript(src: string): boolean {
  const url = src.trim();
  if (url === "" || url.startsWith("//") || URL_SCHEME.test(url)) return true;
  // クエリとハッシュは配信の対象外。拡張子だけを見る。
  const path = url.split(/[?#]/, 1)[0] ?? "";
  return previewContentType(path) !== null;
}

type HtmlTag = { name: string; closing: boolean; attrs: Map<string, string>; end: number };

const TAG_NAME = /[A-Za-z0-9:-]/;
const SPACE = /\s/;

// `<` から 1 つのタグを読む。属性の順序と引用符に依存しないよう、値まで自前で切り出す。
function readTag(html: string, start: number): HtmlTag | null {
  let i = start + 1;
  const closing = html.charAt(i) === "/";
  if (closing) i += 1;
  const nameStart = i;
  while (i < html.length && TAG_NAME.test(html.charAt(i))) i += 1;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();

  const attrs = new Map<string, string>();
  while (i < html.length) {
    const ch = html.charAt(i);
    if (ch === ">") return { name, closing, attrs, end: i + 1 };
    if (SPACE.test(ch) || ch === "/") {
      i += 1;
      continue;
    }
    const attrStart = i;
    while (i < html.length && !/[\s/>=]/.test(html.charAt(i))) i += 1;
    const attrName = html.slice(attrStart, i).toLowerCase();
    while (i < html.length && SPACE.test(html.charAt(i))) i += 1;
    let value = "";
    if (html.charAt(i) === "=") {
      i += 1;
      while (i < html.length && SPACE.test(html.charAt(i))) i += 1;
      const quote = html.charAt(i);
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        if (end < 0) return null;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !/[\s>]/.test(html.charAt(i))) i += 1;
        value = html.slice(valueStart, i);
      }
    }
    // 同じ属性が 2 度出たら先勝ちにする。ブラウザも最初の src を使う。
    if (!attrs.has(attrName)) attrs.set(attrName, value);
  }
  return null;
}

const CLOSING_SCRIPT = /<\/script/gi;

function closingScript(html: string, from: number): number {
  CLOSING_SCRIPT.lastIndex = from;
  const match = CLOSING_SCRIPT.exec(html);
  return match === null ? -1 : match.index;
}

// HTML の中の `<script src>` を走査し、配信できないスクリプトを読み込むときだけ理由を返す。
// iframe の中身は書き換えない。CSS やモックの挙動を変えずに、白紙の理由だけを画面へ出す。
// コメントアウトされたタグと、インライン script の中の文字列は走査しない。
export function previewWarning(html: string): PreviewWarning | null {
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<", i);
    if (open < 0) return null;
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    const tag = readTag(html, open);
    if (tag === null) {
      i = open + 1;
      continue;
    }
    i = tag.end;
    if (tag.closing || tag.name !== "script") continue;
    const src = tag.attrs.get("src");
    // src の無い script は中身が本文。文字列から組み立てたタグで案内を出さない。
    if (src === undefined) {
      const close = closingScript(html, i);
      if (close < 0) return null;
      i = close;
      continue;
    }
    if (!isDeliverableScript(src)) return "script";
  }
  return null;
}
