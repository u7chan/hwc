// 添付はまだ送信できないので、一覧に積むだけの状態。API ができたら実体を送る。
export const ATTACHMENT_LIMIT = 10;

export type Attachment = {
  id: string;
  name: string;
  size: number;
};

// テストで DOM を持ち込まないよう、必要な項目だけを受け取る。
type PickedFile = { name: string; size: number; lastModified: number };

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
  };
}

// 同じファイルを 2 回落としても増えないようにし、上限で打ち切る。
export function addAttachments(
  current: readonly Attachment[],
  incoming: readonly PickedFile[],
  limit = ATTACHMENT_LIMIT,
): Attachment[] {
  const seen = new Set(current.map((item) => item.id));
  const next = [...current];
  for (const file of incoming) {
    const attachment = toAttachment(file);
    if (seen.has(attachment.id)) continue;
    if (next.length >= limit) break;
    seen.add(attachment.id);
    next.push(attachment);
  }
  return next;
}

export function removeAttachment(current: readonly Attachment[], id: string): Attachment[] {
  return current.filter((item) => item.id !== id);
}
