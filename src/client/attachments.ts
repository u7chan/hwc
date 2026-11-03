import { attachmentExtOf, MAX_ATTACHMENTS } from "../shared/attachments";

// clipboardData.items のうち、BFF が受け付ける画像だけを File にする。
// DataTransferItemList は length と添字だけを使うので、テストでは同じ形の配列を渡せる。
export type ClipboardItemLike = {
  kind: string;
  type: string;
  getAsFile: () => File | null;
};

export function imageFilesFrom(items: ArrayLike<ClipboardItemLike> | null | undefined): File[] {
  if (!items) return [];
  const files: File[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== "file") continue;
    if (attachmentExtOf(item.type) === null) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export const SEND_FAILED_NOTICE = "送信できませんでした";

export const ATTACHMENT_LIMIT_NOTICE = `画像は ${MAX_ATTACHMENTS} 枚まで添付できます`;

// 何が起きたかを分けて出す。413 と 415 は利用者が直せる。
export function uploadFailureNotice(status: number): string {
  if (status === 413) return "画像が大きすぎます（10MB まで）";
  if (status === 415) return "対応していない画像形式です（PNG / JPEG / WebP）";
  return "画像を送信できませんでした";
}
