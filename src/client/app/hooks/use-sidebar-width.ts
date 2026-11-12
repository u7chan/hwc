import type { RefObject } from "preact";
import { useEffect, useRef, useState, type Dispatch, type StateUpdater } from "preact/hooks";
import { SIDEBAR_STORAGE_KEY, clampSidebarWidth, parseSidebarWidth } from "../../layout";

export type UseSidebarWidth = {
  sidebarWidth: number;
  setSidebarWidth: Dispatch<StateUpdater<number>>;
  saveSidebarWidth: (width: number) => void;
  drag: RefObject<{ startX: number; startWidth: number } | null>;
};

// 一覧の幅は端末ごとの見え方。Herdr 側には持たせない。ドラッグ中は描き直すだけで保存せず、
// 離したときとキー操作のときだけ書く。
export function useSidebarWidth(): UseSidebarWidth {
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    parseSidebarWidth(
      typeof localStorage === "undefined" ? null : localStorage.getItem(SIDEBAR_STORAGE_KEY),
    ),
  );
  // 画面が狭くなったら一覧も詰める。詳細が読めない幅にはしない。
  useEffect(() => {
    const fit = () => setSidebarWidth((width) => clampSidebarWidth(width, window.innerWidth));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const saveSidebarWidth = (width: number) => {
    const clamped = clampSidebarWidth(width, window.innerWidth);
    setSidebarWidth(clamped);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(clamped));
      } catch {
        // 保存だけ諦める。
      }
    }
  };

  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  return { sidebarWidth, setSidebarWidth, saveSidebarWidth, drag };
}
