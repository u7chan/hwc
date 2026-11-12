import type { RefObject } from "preact";
import { useRef } from "preact/hooks";
import { OPEN_GROUPS_STORAGE_KEY, parseOpenGroups, rememberGroup } from "../../expanded";

export type UseOpenGroups = {
  openGroups: RefObject<ReadonlyMap<string, boolean> | null>;
  rememberOpen: (groupIds: readonly string[], open: boolean) => void;
};

// 開閉の記憶は初期表示と切り替えのときだけ読む。描き直しには使わないので、state ではなく
// ref に持つ。SSE の購読のように 1 度しか張らない処理からも同じ値を読める。
export function useOpenGroups(): UseOpenGroups {
  const openGroups = useRef<ReadonlyMap<string, boolean> | null>(null);
  openGroups.current ??= parseOpenGroups(
    typeof localStorage === "undefined" ? null : localStorage.getItem(OPEN_GROUPS_STORAGE_KEY),
  );

  // 開閉は次に開いたときも同じにしたいので、既定からの差分として覚える。
  const rememberOpen = (groupIds: readonly string[], open: boolean) => {
    let remembered = openGroups.current ?? new Map<string, boolean>();
    for (const groupId of groupIds) remembered = rememberGroup(remembered, groupId, open);
    openGroups.current = remembered;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(
          OPEN_GROUPS_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(remembered)),
        );
      } catch {
        // 保存だけ諦める。
      }
    }
  };

  return { openGroups, rememberOpen };
}
