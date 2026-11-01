// 添付はまだ送信できないので、一覧に積むだけの状態。API ができたら実体を送る。
export const ATTACHMENT_LIMIT = 10;
export const TEXT_PREVIEW_BYTES = 256 * 1024;

export type Attachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  blob: Blob | null;
};

// テストで DOM を持ち込まないよう、必要な項目だけを受け取る。
type PickedFile = {
  name: string;
  size: number;
  lastModified: number;
  type?: string;
  blob?: Blob;
};

export type AttachmentKind = "image" | "text" | "pdf" | "none";

// 中身を見せられる形式か、別のタブで開く形式か、それ以外か。
const TEXT_EXTENSIONS = [
  "txt",
  "md",
  "json",
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "html",
  "yml",
  "yaml",
  "log",
  "csv",
  "sh",
  "py",
  "rs",
  "go",
  "toml",
  "ini",
  "xml",
  "env",
];

export function attachmentKind(file: { name: string; type?: string }): AttachmentKind {
  const type = (file.type ?? "").toLowerCase();
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";

  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.startsWith("text/") || TEXT_EXTENSIONS.includes(extension)) return "text";
  return "none";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function toAttachment(file: PickedFile): Attachment {
  return {
    id: `${file.name}:${file.size}:${file.lastModified}`,
    name: file.name,
    size: file.size,
    type: file.type ?? "",
    blob: file.blob ?? null,
  };
}

// 同じファイルを 2 回落としても増えないようにし、上限で打ち切る。
// 打ち切った件数は呼び出し側で知らせる。
export function addAttachments(
  current: readonly Attachment[],
  incoming: readonly PickedFile[],
  limit = ATTACHMENT_LIMIT,
): { attachments: Attachment[]; rejected: number } {
  const seen = new Set(current.map((item) => item.id));
  const attachments = [...current];
  let rejected = 0;

  for (const file of incoming) {
    const attachment = toAttachment(file);
    if (seen.has(attachment.id)) continue;
    if (attachments.length >= limit) {
      rejected += 1;
      continue;
    }
    seen.add(attachment.id);
    attachments.push(attachment);
  }

  return { attachments, rejected };
}

export function removeAttachment(current: readonly Attachment[], id: string): Attachment[] {
  return current.filter((item) => item.id !== id);
}
