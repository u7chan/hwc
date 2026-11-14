import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { readDraft, storage, writeDraft } from "../drafts";

export type UseDraft = {
  draft: string;
  setDraft: (value: string) => void;
  clearDraft: () => void;
};

type PendingDraft = { owner: symbol; text: string };

// 同一セッション内で、まだ localStorage に書いていない最新の下書き。ペインを切り替えると
// 入力欄はアンマウントされ、Preact の passive cleanup は新しいインスタンスの render より
// 後に走る。cleanup の書き込みだけに任せると、開き直したインスタンスが古い値（空）を
// 読む。入力のたびにメモリへ置き、次のインスタンスはここから復元する。
// owner は書いたインスタンス。遅れて届いた送信成功の clearDraft が、開き直した別の
// インスタンスの下書きを消さないようにする。
const pendingDrafts = new Map<string, PendingDraft>();

// 下書きはペインごとに残す。書きかけのまま一覧へ戻っても消えない。
// 打つたびに書くと重いので、手が止まってから残す。compact チップ中の draft は指示であり、
// 復元するとチップが無いぶん本文として送られてしまうので保存しない。
export function useDraft(paneId: string, persist: boolean): UseDraft {
  const owner = useRef<symbol | null>(null);
  const ownerId = owner.current ?? (owner.current = Symbol("draft"));
  const [draft, setDraftState] = useState(
    () => pendingDrafts.get(paneId)?.text ?? readDraft(storage(), paneId),
  );
  // アンマウント時の書き込みで、その時点の保存可否を読む。
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // 入力のたびに、localStorage の debounce を待たずにメモリへ置く。切り替えた直後に
  // 開き直しても、新しいインスタンスがこの値を読める。チップ中の指示は保存しない。
  const setDraft = (value: string) => {
    if (persist) pendingDrafts.set(paneId, { owner: ownerId, text: value });
    setDraftState(value);
  };

  // 復元した値や、setDraft 以外の経路で変わった値もメモリへ揃える。チップ中は消す。
  useLayoutEffect(() => {
    if (persist) {
      pendingDrafts.set(paneId, { owner: ownerId, text: draft });
      return;
    }
    if (pendingDrafts.get(paneId)?.owner === ownerId) pendingDrafts.delete(paneId);
  }, [draft, ownerId, paneId, persist]);

  useEffect(() => {
    if (!persist) return;
    const text = draft;
    const timer = setTimeout(() => writeDraft(storage(), paneId, text), 250);
    return () => clearTimeout(timer);
  }, [draft, paneId, persist]);

  // 250ms 待たずにアンマウントされても、保存対象ならその場で localStorage へ書く。
  // 新しいインスタンスが引き継いだ下書きは、そちらの debounce / cleanup に任せる。
  useEffect(() => {
    return () => {
      if (!persistRef.current) return;
      const pending = pendingDrafts.get(paneId);
      if (pending === undefined || pending.owner !== ownerId) return;
      writeDraft(storage(), paneId, pending.text);
    };
  }, [ownerId, paneId]);

  // debounce を待たずに消す。アンマウント後に届いた送信成功で、新しいインスタンスの
  // 下書きを消さないよう、所有者が自分であるときだけ消す。
  const clearDraft = () => {
    const pending = pendingDrafts.get(paneId);
    if (pending !== undefined && pending.owner !== ownerId) return;
    pendingDrafts.set(paneId, { owner: ownerId, text: "" });
    writeDraft(storage(), paneId, "");
    setDraftState("");
  };

  return { draft, setDraft, clearDraft };
}
