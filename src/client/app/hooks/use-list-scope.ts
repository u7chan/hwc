import { useState } from "preact/hooks";
import { LIST_SCOPE_STORAGE_KEY, parseListScope, type ListScope } from "../../scope";

export type UseListScope = {
  scope: ListScope;
  changeScope: (next: ListScope) => void;
};

// 一覧をどこまで出すかは端末ごとの見え方。Herdr 側には持たせない。スコープを変えると、
// 前のスコープで出した「一覧をその場所へ送る」要求は意味を失うので、resetReveal で捨てる。
export function useListScope(resetReveal: () => void): UseListScope {
  const [scope, setScope] = useState<ListScope>(() =>
    parseListScope(
      typeof localStorage === "undefined" ? null : localStorage.getItem(LIST_SCOPE_STORAGE_KEY),
    ),
  );

  const changeScope = (next: ListScope) => {
    resetReveal();
    setScope(next);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(LIST_SCOPE_STORAGE_KEY, next);
      } catch {
        // 保存だけ諦める。
      }
    }
  };

  return { scope, changeScope };
}
