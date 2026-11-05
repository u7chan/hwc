import {
  attachmentExtOf,
  attachmentTypeLabels,
  formatMegaBytes,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
} from "../shared/attachments";

// DataTransferItemList は length と添字だけを使うので、テストでは同じ形の配列を渡せる。
export type ClipboardItemLike = {
  kind: string;
  type: string;
  getAsFile: () => File | null;
};

// 貼り付け・ドロップに対して何をするか。テキストだけなら既定のまま、未対応形式は通知だけ、
// 受け付けた画像があれば既定動作を止めてアップロードする。
export type AttachmentAction =
  | { kind: "default" }
  | { kind: "unsupported" }
  | { kind: "upload"; files: File[]; unsupported: boolean };

export function pasteActionFrom(
  items: ArrayLike<ClipboardItemLike> | null | undefined,
): AttachmentAction {
  if (!items) return { kind: "default" };

  const files: File[] = [];
  let unsupported = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== "file") continue;
    // 画像以外の項目は入力欄の既定動作に任せる。
    if (!item.type.startsWith("image/")) continue;
    if (attachmentExtOf(item.type) === null) {
      unsupported = true;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }

  if (files.length > 0) return { kind: "upload", files, unsupported };
  return unsupported ? { kind: "unsupported" } : { kind: "default" };
}

// ドロップでは DataTransfer.files（kind を持たない File の一覧）を見る。
// 画像以外のファイルは既定動作に任せ、未対応の画像形式だけを知らせる。
export function dropActionFrom(files: ArrayLike<File> | null | undefined): AttachmentAction {
  if (!files) return { kind: "default" };

  const accepted: File[] = [];
  let unsupported = false;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || !file.type.startsWith("image/")) continue;
    if (attachmentExtOf(file.type) === null) {
      unsupported = true;
      continue;
    }
    accepted.push(file);
  }

  if (accepted.length > 0) return { kind: "upload", files: accepted, unsupported };
  return unsupported ? { kind: "unsupported" } : { kind: "default" };
}

export const SEND_FAILED_NOTICE = "送信できませんでした";
export const STOP_FAILED_NOTICE = "停止できませんでした";
// シェルは 1 行ずつしか渡せない（端末は改行を入力として扱えない）。
export const SHELL_NEWLINE_NOTICE = "シェルでは改行できません（1 行ずつ送ってください）";

export const ATTACHMENT_LIMIT_NOTICE = `画像は ${MAX_ATTACHMENTS} 枚まで添付できます`;

// クライアントで弾いた場合と BFF が 415 を返した場合で同じ文言を使う。
export function unsupportedImageNotice(): string {
  return `対応していない画像形式です（${attachmentTypeLabels()}）`;
}

// 何が起きたかを分けて出す。413 と 415 は利用者が直せる。
export function uploadFailureNotice(status: number): string {
  if (status === 413) {
    return `画像が大きすぎます（${formatMegaBytes(MAX_ATTACHMENT_BYTES)} まで）`;
  }
  if (status === 415) return unsupportedImageNotice();
  return "画像を送信できませんでした";
}
