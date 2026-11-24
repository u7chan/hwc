import { asRecord } from "./json";

// hwc と mypi の間で共有する rewind の契約。mypi 側の src/hwc-rewind/core.ts と
// 同じ形を保つ。marker はセッションの custom entry で、PI の LLM 文脈には入らない。
export const REWIND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const REWIND_CAPABILITY_TYPE = "hwc-capabilities";
export const REWIND_MARKER_TYPE = "hwc-rewind";

export type EditMessageBody = { messageId: string; requestId: string; text: string };

export type RewindMarker = {
  v: 1;
  requestId: string;
  targetId: string;
  leafId: string | null;
};

export function isRewindId(value: unknown): value is string {
  return typeof value === "string" && REWIND_ID_PATTERN.test(value);
}

export function isRewindCapability(record: Record<string, unknown>): boolean {
  if (record.type !== "custom" || record.customType !== REWIND_CAPABILITY_TYPE) return false;
  const data = asRecord(record.data);
  return data?.v === 1 && data.rewind === true;
}

export function parseRewindMarker(record: Record<string, unknown>): RewindMarker | null {
  if (record.type !== "custom" || record.customType !== REWIND_MARKER_TYPE) return null;
  const data = asRecord(record.data);
  if (data === null || data.v !== 1) return null;
  if (!isRewindId(data.requestId) || !isRewindId(data.targetId)) return null;
  const leafId = data.leafId;
  if (leafId !== null && !isRewindId(leafId)) return null;
  // 移動していない marker は受け付けない。親と leafId が一致しないものも壊れている。
  if (leafId === data.targetId) return null;
  if (record.parentId !== leafId) return null;
  return { v: 1, requestId: data.requestId, targetId: data.targetId, leafId };
}
