import {
  type AttachmentKind,
  attachmentKindOfFileName,
  formatMegaBytes,
  MAX_ATTACHMENTS,
  maxAttachmentBytes,
} from "../shared/attachments";

// DataTransferItemList は length と添字だけを使うので、テストでは同じ形の配列を渡せる。
export type ClipboardItemLike = {
  kind: string;
  type: string;
  getAsFile: () => File | null;
};

// 貼り付け・ドロップに対して何をするか。ファイルが無ければ既定のまま、
// あれば既定動作を止めてアップロードする。
export type AttachmentAction = { kind: "default" } | { kind: "upload"; files: File[] };

export function pasteActionFrom(
  items: ArrayLike<ClipboardItemLike> | null | undefined,
): AttachmentAction {
  if (!items) return { kind: "default" };

  const files: File[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }

  return files.length > 0 ? { kind: "upload", files } : { kind: "default" };
}

// ドロップでは DataTransfer.files（kind を持たない File の一覧）を見る。
export function dropActionFrom(files: ArrayLike<File> | null | undefined): AttachmentAction {
  if (!files) return { kind: "default" };

  const accepted: File[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file) accepted.push(file);
  }

  return accepted.length > 0 ? { kind: "upload", files: accepted } : { kind: "default" };
}

export const SEND_FAILED_NOTICE = "送信できませんでした";
export const STOP_FAILED_NOTICE = "停止できませんでした";
// シェルは 1 行ずつしか渡せない（端末は改行を入力として扱えない）。
export const SHELL_NEWLINE_NOTICE = "シェルでは改行できません（1 行ずつ送ってください）";
// エージェントはシェルの前景プロセスを引き継がない。先に止めてもらう。
export const SHELL_BUSY_NOTICE = "コマンドが動いています。停止してから起動できます";

export const ATTACHMENT_LIMIT_NOTICE = `添付は ${MAX_ATTACHMENTS} 件までです`;

// 上限は種別で違う。文言も種別ごとの値から組み立て、片方だけ変えて古い数値を出さない。
export function attachmentTooLargeNotice(kind: AttachmentKind): string {
  return `${kind === "image" ? "画像" : "ファイル"}が大きすぎます（${formatMegaBytes(maxAttachmentBytes(kind))} まで）`;
}

// 25MB を LAN 越しに送り切ってから 413 を出すのは遅い。サーバーと同じ拡張子の判定で先に弾く。
export function exceedsAttachmentLimit(file: { name: string; size: number }): boolean {
  return file.size > maxAttachmentBytes(attachmentKindOfFileName(file.name));
}

// 何が起きたかを分けて出す。413 は利用者が直せる。
export function uploadFailureNotice(status: number, kind: AttachmentKind): string {
  if (status === 413) return attachmentTooLargeNotice(kind);
  return "ファイルを送信できませんでした";
}
