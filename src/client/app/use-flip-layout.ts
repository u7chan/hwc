import { useLayoutEffect, useRef } from "preact/hooks";

// タブは列のスクロールを含めた位置で控える。
type TabPoint = { left: number; top: number };

// ドロップで位置が変わったセルを、前の位置から滑らせる。分割で増えたセルは
// フェードで入れる。初回表示とウィンドウのリサイズでは動かさない。
// タブは同じセルの中の並べ替えだけを滑らせる。セルをまたぐ移動は列の原点が
// 違うので、移動先で新しく現れたものとして扱う。
// 変更の直前に capture を呼び、変更後の描画で滑らせる。
export function useFlipLayout(splitKey: string): () => void {
  const flipRects = useRef<Map<string, DOMRect> | null>(null);
  const flipTabRects = useRef<Map<string, Map<string, TabPoint>> | null>(null);

  // 変更の直前にセルとタブの位置を控える。セルは [data-flip-cell]（葉の代表）、
  // タブは列のスクロールを含めた位置で比べる。
  const capture = () => {
    const rects = new Map<string, DOMRect>();
    for (const cell of document.querySelectorAll<HTMLElement>("[data-flip-cell]")) {
      const key = cell.dataset.flipCell;
      if (key !== undefined) rects.set(key, cell.getBoundingClientRect());
    }
    flipRects.current = rects;
    const tabRects = new Map<string, Map<string, TabPoint>>();
    for (const list of document.querySelectorAll<HTMLElement>("[data-tab-list]")) {
      const owner = list.dataset.tabList;
      if (owner === undefined || owner === "") continue;
      const listRect = list.getBoundingClientRect();
      const points = new Map<string, TabPoint>();
      for (const item of list.querySelectorAll<HTMLElement>("[data-tab-pane]")) {
        const paneId = item.dataset.tabPane;
        if (paneId === undefined) continue;
        const rect = item.getBoundingClientRect();
        points.set(paneId, {
          left: rect.left - listRect.left + list.scrollLeft,
          top: rect.top - listRect.top,
        });
      }
      tabRects.set(owner, points);
    }
    flipTabRects.current = tabRects;
  };

  useLayoutEffect(() => {
    const before = flipRects.current;
    const beforeTabs = flipTabRects.current;
    flipRects.current = null;
    flipTabRects.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (beforeTabs !== null) {
      for (const list of document.querySelectorAll<HTMLElement>("[data-tab-list]")) {
        const owner = list.dataset.tabList;
        const previousPoints = owner === undefined ? undefined : beforeTabs.get(owner);
        if (previousPoints === undefined) continue;
        const listRect = list.getBoundingClientRect();
        for (const item of list.querySelectorAll<HTMLElement>("[data-tab-pane]")) {
          // 外すアニメーション中のタブは幅を動かしている。同じ要素を動かさない。
          if (item.dataset.leaving === "true") continue;
          const pane = item.dataset.tabPane;
          const previous = pane === undefined ? undefined : previousPoints.get(pane);
          if (previous === undefined) continue;
          const rect = item.getBoundingClientRect();
          const dx = previous.left - (rect.left - listRect.left + list.scrollLeft);
          const dy = previous.top - (rect.top - listRect.top);
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
          item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
            duration: 200,
            easing: "cubic-bezier(.2, 0, 0, 1)",
          });
        }
      }
    }
    if (before === null || before.size === 0) return;
    for (const cell of document.querySelectorAll<HTMLElement>("[data-flip-cell]")) {
      const key = cell.dataset.flipCell;
      if (key === undefined) continue;
      const previous = before.get(key);
      if (previous === undefined) {
        cell.animate(
          [
            { opacity: 0, transform: "scale(0.985)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 160, easing: "cubic-bezier(.2, 0, 0, 1)" },
        );
        continue;
      }
      const now = cell.getBoundingClientRect();
      const dx = previous.left - now.left;
      const dy = previous.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      cell.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 200,
        easing: "cubic-bezier(.2, 0, 0, 1)",
      });
    }
  }, [splitKey]);

  return capture;
}
