import type { RefObject } from "preact";
import { useRef } from "preact/hooks";
import { loadOpenGroups, rememberGroup, saveOpenGroups } from "../../expanded";
import { storage } from "../../storage";

export type UseOpenGroups = {
  openGroups: RefObject<ReadonlyMap<string, boolean> | null>;
  rememberOpen: (groupIds: readonly string[], open: boolean) => void;
};

// 開閉の記憶は初期表示と切り替えのときだけ読む。描き直しには使わないので、state ではなく
// ref に持つ。SSE の購読のように 1 度しか張らない処理からも同じ値を読める。
export function useOpenGroups(): UseOpenGroups {
  const openGroups = useRef<ReadonlyMap<string, boolean> | null>(null);
  openGroups.current ??= loadOpenGroups(storage());

  // 開閉は次に開いたときも同じにしたいので、既定からの差分として覚える。
  const rememberOpen = (groupIds: readonly string[], open: boolean) => {
    let remembered = openGroups.current ?? new Map<string, boolean>();
    for (const groupId of groupIds) remembered = rememberGroup(remembered, groupId, open);
    openGroups.current = remembered;
    saveOpenGroups(storage(), remembered);
  };

  return { openGroups, rememberOpen };
}
