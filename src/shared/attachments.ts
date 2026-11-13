// 添付の規則は BFF と client で同じでなければならない。保存名・配信 URL・注記の書式を
// 片方だけ変えると、送った画像が履歴から開けなくなる。

export const MAX_ATTACHMENTS = 4;

// 画像はスクリーンショットや写真で、10MB を超えるものはまず無い。画像以外は zip や
// Office 文書で、25MB までを全量バッファで受ける。
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// エージェントが本文に書いたファイルのプレビュー配信の上限。添付の上限とは別に持つ。
// 添付の上限を上げても、会話を開くたびに読む量は変えない。
export const MAX_PREVIEW_FILE_BYTES = 10 * 1024 * 1024;

export type AttachmentExt = "png" | "jpg" | "webp";
export type AttachmentKind = "image" | "file";

const CONTENT_TYPE_BY_EXT: ReadonlyMap<AttachmentExt, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
]);

const EXTENSIONS: ReadonlySet<string> = new Set(CONTENT_TYPE_BY_EXT.keys());

const BYTES_PER_MB = 1024 * 1024;

// 保存名の上限。Windows の MAX_PATH ではなく、注記 1 行と URL 1 セグメントに収まる長さで決める。
export const MAX_ATTACHMENT_NAME_BYTES = 200;
const MAX_EXTENSION_BYTES = 16;
// percent-encode すると 1 バイトが最大 3 文字になる。decode の前に長さで弾く。
const MAX_ENCODED_NAME_LENGTH = MAX_ATTACHMENT_NAME_BYTES * 3;

const ENCODER = new TextEncoder();

function byteLength(value: string): number {
  return ENCODER.encode(value).length;
}

// 拡張子を残したまま、コードポイントの境界で切る。バイト列の途中で切ると壊れた文字が残る。
function truncateName(value: string, limit: number): string {
  if (byteLength(value) <= limit) return value;
  let used = 0;
  let kept = "";
  for (const character of value) {
    const size = byteLength(character);
    if (used + size > limit) break;
    kept += character;
    used += size;
  }
  return kept;
}

// 名前に入れない文字を落とす。`/` と `\` はパス区切り、`<` と `>` は注記の区切り、
// C0 / DEL / C1 は行や URL を壊す。
function stripNameCharacters(raw: string): string {
  let kept = "";
  for (const character of raw) {
    if (character === "/" || character === "\\" || character === "<" || character === ">") {
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    kept += character;
  }
  return kept;
}

// 保存名は利用者由来で、そのまま注記・履歴・URL に出る。パスへ連結する前にこの規則を
// 通し、通した後も同じ名前になるものだけを受け付ける。
// 先頭の `.` は隠しファイル名を、`-` はシェルのオプションを装う名前を落とす。
export function sanitizeAttachmentName(raw: string): string {
  const cleaned = stripNameCharacters(raw).normalize("NFC");
  const trimmed = cleaned.replace(/^[.-]+/, "").replace(/[. ]+$/, "");
  if (trimmed === "") return "";

  const dot = trimmed.lastIndexOf(".");
  const extension =
    dot > 0 && byteLength(trimmed.slice(dot)) <= MAX_EXTENSION_BYTES ? trimmed.slice(dot) : "";
  const stem = extension === "" ? trimmed : trimmed.slice(0, dot);
  // 切り詰めで末尾の空白や `.` が戻るので、切った後にもう一度落とす。
  const body = truncateName(stem, MAX_ATTACHMENT_NAME_BYTES - byteLength(extension)).replace(
    /[. ]+$/,
    "",
  );
  if (body === "") return "";
  return body + extension;
}

export function isStoredAttachmentName(value: string): boolean {
  // UTF-16 の長さは UTF-8 のバイト数を超えない。長すぎる値は正規化の前に落とす。
  if (value === "" || value.length > MAX_ATTACHMENT_NAME_BYTES) return false;
  return sanitizeAttachmentName(value) === value;
}

const EXT_ALIASES: ReadonlyMap<string, AttachmentExt> = new Map([["jpeg", "jpg"]]);

// 保存名だけでなく、エージェントが書いた任意のファイル名からも型を決める。
// allowlist を 2 か所に分けないよう、拡張子の対応はここだけが持つ。
export function attachmentExtFromName(name: string): AttachmentExt | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (EXTENSIONS.has(ext)) return ext as AttachmentExt;
  return EXT_ALIASES.get(ext) ?? null;
}

export function attachmentContentTypeFromName(name: string): string | null {
  const ext = attachmentExtFromName(name);
  return ext === null ? null : (CONTENT_TYPE_BY_EXT.get(ext) ?? null);
}

// 配信してよいのは画像 3 形式だけ。保存名の検証とは別に、この 1 か所で絞る。
export function isImageAttachmentName(value: string): boolean {
  return isStoredAttachmentName(value) && attachmentExtFromName(value) !== null;
}

export function attachmentContentType(name: string): string | null {
  if (!isImageAttachmentName(name)) return null;
  return attachmentContentTypeFromName(name);
}

export function attachmentKindOfName(name: string): AttachmentKind {
  return attachmentExtFromName(name) === null ? "file" : "image";
}

// クライアントが持つのは保存前の file.name。保存名に直してから種別を決め、
// 上限の判定を BFF と同じ規則に揃える。
export function attachmentKindOfFileName(name: string): AttachmentKind {
  return attachmentKindOfName(sanitizeAttachmentName(name));
}

export function maxAttachmentBytes(kind: AttachmentKind): number {
  return kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_FILE_ATTACHMENT_BYTES;
}

// 元のファイル名は ASCII しか運べないヘッダで受ける。decode できない値は名前にしない。
export const FILENAME_HEADER = "x-hwc-filename";

export function encodeAttachmentName(name: string): string {
  return encodeURIComponent(name);
}

export function decodeAttachmentName(value: string | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (value.length > MAX_ENCODED_NAME_LENGTH) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// 同名は上書きせず連番にする。拡張子の前に足し、全体を上限に収める。
export function attachmentCollisionName(name: string, index: number): string {
  if (index === 0) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const stem = extension === "" ? name : name.slice(0, dot);
  const suffix = `-${index}`;
  const limit = Math.max(1, MAX_ATTACHMENT_NAME_BYTES - byteLength(extension) - suffix.length);
  return `${truncateName(stem, limit).replace(/[. ]+$/, "")}${suffix}${extension}`;
}

export function formatMegaBytes(bytes: number): string {
  const mb = bytes / BYTES_PER_MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

// ペイン id はそのままディレクトリ名になる。区切りと親参照を含む id をここで弾く。
export function isSafePaneId(value: string): boolean {
  if (value === "" || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20) return false;
  }
  return true;
}

export const ATTACHED_FILES_OPEN = "<attached_files>";
export const ATTACHED_FILES_CLOSE = "</attached_files>";

export function composeAttachedFilesNote(paths: readonly string[]): string {
  const lines = paths.map((path) => `- ${path}`).join("\n");
  return `${ATTACHED_FILES_OPEN}\n${lines}\n${ATTACHED_FILES_CLOSE}`;
}

// 本文が空なら注記だけ。空でなければ空行 1 つを挟む。
export function composeInputText(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const note = composeAttachedFilesNote(paths);
  return text === "" ? note : `${text}\n\n${note}`;
}

function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? path : path.slice(index + 1);
}

// 最後の 1 組だけを見る。本文中に同じ形の文字列があっても、それは本文のまま残す。
// 有効な名前が 1 つも取れないときは strip しない。書式の外れた注記を消して
// 本文だけを黙って捨てるより、そのまま見せる方が安全。
export function stripAttachedFiles(text: string): { text: string; attachments: string[] } {
  const open = text.lastIndexOf(ATTACHED_FILES_OPEN);
  if (open < 0) return { text, attachments: [] };
  const close = text.indexOf(ATTACHED_FILES_CLOSE, open + ATTACHED_FILES_OPEN.length);
  if (close < 0) return { text, attachments: [] };

  const inner = text.slice(open + ATTACHED_FILES_OPEN.length, close);
  const attachments = inner
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => baseName(line.slice(2).trim()))
    .filter(isStoredAttachmentName);
  if (attachments.length === 0) return { text, attachments: [] };

  return { text: text.slice(0, open).replace(/\n+$/, ""), attachments };
}
