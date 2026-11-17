import { useState } from "preact/hooks";
import { loadSplitPrefs, saveSplitPrefs, type SplitPrefs } from "../../split-prefs";

export type UseSplitPreference = {
  prefs: SplitPrefs;
  change: (next: SplitPrefs) => void;
};

// 分割表示の好みは端末ごと。テーマと同じく、読み書きは localStorage に閉じる（ADR 0092）。
export function useSplitPreference(): UseSplitPreference {
  const [prefs, setPrefs] = useState<SplitPrefs>(() =>
    loadSplitPrefs(typeof localStorage === "undefined" ? null : localStorage),
  );

  const change = (next: SplitPrefs) => {
    setPrefs(next);
    if (typeof localStorage !== "undefined") saveSplitPrefs(localStorage, next);
  };

  return { prefs, change };
}
