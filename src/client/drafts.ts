import type { StorageLike } from "./storage";

export { storage } from "./storage";

export const DRAFT_PREFIX = "hwc-draft:";
// 長すぎる下書きは残さない。localStorage は同期的に書くので、容量も時間も食いたくない。
export const DRAFT_MAX_LENGTH = 8000;

// 保存できない環境（プライベートモード等）でも入力自体は止めない。
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

export function draftKey(paneId: string): string {
  return `${DRAFT_PREFIX}${paneId}`;
}

function read(storage: StorageLike | null, key: string): string {
  if (!storage) return "";
  return safely(() => storage.getItem(key) ?? "", "");
}

function write(storage: StorageLike | null, key: string, text: string, maxLength: number): void {
  if (!storage) return;
  safely(() => {
    if (text === "") storage.removeItem(key);
    else if (text.length <= maxLength) storage.setItem(key, text);
  }, undefined);
}

export function readDraft(storage: StorageLike | null, paneId: string): string {
  return read(storage, draftKey(paneId));
}

export function writeDraft(storage: StorageLike | null, paneId: string, text: string): void {
  write(storage, draftKey(paneId), text, DRAFT_MAX_LENGTH);
}
