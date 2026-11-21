import { useState } from "preact/hooks";
import { loadListScope, saveListScope, type ListScope } from "../../scope";
import { storage } from "../../storage";

export type UseListScope = {
  scope: ListScope;
  changeScope: (next: ListScope) => void;
};

// 一覧をどこまで出すかは端末ごとの見え方。Herdr 側には持たせない。スコープを変えると、
// 前のスコープで出した「一覧をその場所へ送る」要求は意味を失うので、resetReveal で捨てる。
export function useListScope(resetReveal: () => void): UseListScope {
  const [scope, setScope] = useState<ListScope>(() => loadListScope(storage()));

  const changeScope = (next: ListScope) => {
    resetReveal();
    setScope(next);
    saveListScope(storage(), next);
  };

  return { scope, changeScope };
}
