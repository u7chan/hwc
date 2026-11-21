import type { RefObject } from "preact";
import { useEffect, useRef, useState, type Dispatch, type StateUpdater } from "preact/hooks";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth as writeSidebarWidth,
} from "../../layout";
import { storage } from "../../storage";

export type UseSidebarWidth = {
  sidebarWidth: number;
  setSidebarWidth: Dispatch<StateUpdater<number>>;
  saveSidebarWidth: (width: number) => void;
  drag: RefObject<{ startX: number; startWidth: number } | null>;
};

// 一覧の幅は端末ごとの見え方。Herdr 側には持たせない。ドラッグ中は描き直すだけで保存せず、
// 離したときとキー操作のときだけ書く。
export function useSidebarWidth(): UseSidebarWidth {
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth(storage()));
  // 画面が狭くなったら一覧も詰める。詳細が読めない幅にはしない。
  useEffect(() => {
    const fit = () => setSidebarWidth((width) => clampSidebarWidth(width, window.innerWidth));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const saveSidebarWidth = (width: number) => {
    const clamped = clampSidebarWidth(width, window.innerWidth);
    setSidebarWidth(clamped);
    writeSidebarWidth(storage(), clamped);
  };

  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  return { sidebarWidth, setSidebarWidth, saveSidebarWidth, drag };
}
