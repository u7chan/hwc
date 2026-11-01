export const DRAFT_PREFIX = "hwc-draft:";
// 長すぎる下書きは残さない。localStorage は同期的に書くので、容量も時間も食いたくない。
export const DRAFT_MAX_LENGTH = 8000;

type DraftStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

// 保存できない環境（プライベートモード等）でも入力自体は止めない。
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

// localStorage が使えない環境では null を返し、保存だけ諦める。
export function storage(): DraftStorage | null {
  return safely(() => window.localStorage, null);
}

export function draftKey(paneId: string): string {
  return `${DRAFT_PREFIX}${paneId}`;
}

export function readDraft(storage: DraftStorage | null, paneId: string): string {
  if (!storage) return "";
  return safely(() => storage.getItem(draftKey(paneId)) ?? "", "");
}

export function writeDraft(storage: DraftStorage | null, paneId: string, text: string): void {
  if (!storage) return;
  safely(() => {
    if (text === "") storage.removeItem(draftKey(paneId));
    else if (text.length <= DRAFT_MAX_LENGTH) storage.setItem(draftKey(paneId), text);
  }, undefined);
}
