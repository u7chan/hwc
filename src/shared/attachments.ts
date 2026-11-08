// 添付の規則は BFF と client で同じでなければならない。保存名・配信 URL・注記の書式を
// 片方だけ変えると、送った画像が履歴から開けなくなる。

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type AttachmentExt = "png" | "jpg" | "webp";

// SVG は同一オリジンでスクリプトが動く形式なので、保存も配信もしない。
const EXT_BY_CONTENT_TYPE: ReadonlyMap<string, AttachmentExt> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

const CONTENT_TYPE_BY_EXT: ReadonlyMap<AttachmentExt, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
]);

const EXTENSIONS: ReadonlySet<string> = new Set(CONTENT_TYPE_BY_EXT.keys());

// 案内文の表記だけを持つ。受け付ける形式とその並びは allowlist から引く。
const LABEL_BY_EXT: ReadonlyMap<AttachmentExt, string> = new Map([
  ["png", "PNG"],
  ["jpg", "JPEG"],
  ["webp", "WebP"],
]);

const BYTES_PER_MB = 1024 * 1024;

// pasted-<YYYYMMDD>-<HHmmss>[-n].<ext>。名前に規則があるので、配信の前に書式だけで弾ける。
const ATTACHMENT_NAME = /^pasted-\d{8}-\d{6}(-\d+)?\.(png|jpg|webp)$/;

export function isAttachmentName(value: string): boolean {
  return ATTACHMENT_NAME.test(value);
}

export function attachmentExtOf(contentType: string | undefined): AttachmentExt | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return EXT_BY_CONTENT_TYPE.get(type) ?? null;
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

export function attachmentContentType(name: string): string | null {
  if (!isAttachmentName(name)) return null;
  return attachmentContentTypeFromName(name);
}

// 利用者に見せる形式の一覧。allowlist を変えたときに案内文だけが古くならないようにする。
export function attachmentTypeLabels(): string {
  return [...EXT_BY_CONTENT_TYPE.values()].map((ext) => LABEL_BY_EXT.get(ext) ?? ext).join(" / ");
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

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// 同名は上書きせず、index で連番にする。時刻はローカル時刻。
export function attachmentName(ext: AttachmentExt, at: Date, index = 0): string {
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const suffix = index === 0 ? "" : `-${index}`;
  return `pasted-${date}-${time}${suffix}.${ext}`;
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
    .filter(isAttachmentName);
  if (attachments.length === 0) return { text, attachments: [] };

  return { text: text.slice(0, open).replace(/\n+$/, ""), attachments };
}
