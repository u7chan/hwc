import { useEffect, useState } from "preact/hooks";
import type { Dispatch, StateUpdater } from "preact/hooks";
import { readDraft, storage, writeDraft } from "../drafts";

export type UseDraft = {
  draft: string;
  setDraft: Dispatch<StateUpdater<string>>;
  clearDraft: () => void;
};

// 下書きはペインごとに残す。書きかけのまま一覧へ戻っても消えない。
// 打つたびに書くと重いので、手が止まってから残す。compact チップ中の draft は指示であり、
// 復元するとチップが無いぶん本文として送られてしまうので保存しない。
export function useDraft(paneId: string, persist: boolean): UseDraft {
  const [draft, setDraft] = useState(() => readDraft(storage(), paneId));

  useEffect(() => {
    if (!persist) return;
    const text = draft;
    const timer = setTimeout(() => writeDraft(storage(), paneId, text), 250);
    return () => clearTimeout(timer);
  }, [draft, paneId, persist]);

  // debounce を待たずに消す。先にペインを切り替えると古い値が戻る。
  const clearDraft = () => {
    writeDraft(storage(), paneId, "");
    setDraft("");
  };

  return { draft, setDraft, clearDraft };
}
