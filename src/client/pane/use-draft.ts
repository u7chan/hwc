import { useEffect, useRef, useState } from "preact/hooks";
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
  // アンマウント時に最新の draft と保存可否を読む。依存が変わるたびに走る cleanup では
  // 書かない（打つたびに書くのと同じになる）。
  const latest = useRef({ draft, persist });
  latest.current = { draft, persist };

  useEffect(() => {
    if (!persist) return;
    const text = draft;
    const timer = setTimeout(() => writeDraft(storage(), paneId, text), 250);
    return () => clearTimeout(timer);
  }, [draft, paneId, persist]);

  // ペインを切り替えると 250ms の待ちを待たずにアンマウントされる。タイマーだけを
  // 捨てると書きかけが消えるので、保存対象のときだけその場で残す。チップ中の指示
  // （persist=false）は本文として戻すと意味が変わるので保存しない。
  useEffect(() => {
    return () => {
      const { draft: text, persist: save } = latest.current;
      if (save) writeDraft(storage(), paneId, text);
    };
  }, [paneId]);

  // debounce を待たずに消す。先にペインを切り替えると古い値が戻る。
  const clearDraft = () => {
    latest.current = { draft: "", persist };
    writeDraft(storage(), paneId, "");
    setDraft("");
  };

  return { draft, setDraft, clearDraft };
}
