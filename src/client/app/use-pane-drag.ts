import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { clearDragGhostPoint, setDragGhostPoint } from "../DragGhost";
import { startsPaneDrag, type SplitView } from "../split-view";
import { dropTargetAt } from "./drop";
import type { DropTarget } from "./types";

export type PaneDrag = { paneId: string; target: DropTarget | null };

export type UsePaneDrag = {
  // ドラッグ中のペインと落とし先。掴んだ見出しの表示と、落とし先の枠を出すのに使う。
  dragging: PaneDrag | null;
  startPaneDrag: (event: PointerEvent, paneId: string, listStart?: boolean) => void;
  startListPaneDrag: (event: PointerEvent, paneId: string) => void;
  // ドラッグが成立した後の click で選択を動かさない。1 回だけ true を返す。
  consumeDraggedClick: () => boolean;
};

type PaneDragOptions = {
  // ドラッグは PC のポインタだけで始める。
  wide: boolean;
  // 木は描画のたびに作り直される。購読を張り直さずに最新を読むので ref で受ける。
  split: RefObject<SplitView>;
  // 落としたときの適用。描画のたびに作り直されるので、購読側は ref から最新を呼ぶ。
  onDrop: (paneId: string, target: DropTarget) => void;
};

// タブ・セル・一覧の行からの分割ドラッグ。押した時点の位置だけを控え、動き始めてから
// ドラッグにする。クリックとの競合を移動量で分ける（一覧の並べ替えと同じ判定）。
// listStart は一覧の行から始めたドラッグで、触れる画面では縦の動きをスクロールに譲る。
export function usePaneDrag(options: PaneDragOptions): UsePaneDrag {
  const { wide, split, onDrop } = options;
  const press = useRef<{
    paneId: string;
    x: number;
    y: number;
    active: boolean;
    listStart: boolean;
  } | null>(null);
  const dropTarget = useRef<DropTarget | null>(null);
  const [dragging, setDragging] = useState<PaneDrag | null>(null);
  const draggedSincePress = useRef(false);
  const dropLatest = useRef(onDrop);
  dropLatest.current = onDrop;

  const startPaneDrag = (event: PointerEvent, paneId: string, listStart = false) => {
    // 幅の変更でドラッグが始まらない画面でも、抑止は押下のたびに解除する。
    // 前のドラッグの抑止が残ると、一覧へ戻った最初の選択が 1 回無視される。
    draggedSincePress.current = false;
    if (!wide || event.button !== 0) return;
    press.current = {
      paneId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      listStart,
    };
  };

  const startListPaneDrag = (event: PointerEvent, paneId: string) => {
    startPaneDrag(event, paneId, true);
  };

  const consumeDraggedClick = (): boolean => {
    if (!draggedSincePress.current) return false;
    draggedSincePress.current = false;
    return true;
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const dragState = press.current;
      if (dragState === null) return;
      if (!dragState.active) {
        const dx = event.clientX - dragState.x;
        const dy = event.clientY - dragState.y;
        if (!startsPaneDrag(event.pointerType, dragState.listStart, dx, dy)) return;
        dragState.active = true;
        draggedSincePress.current = true;
      }
      event.preventDefault();
      setDragGhostPoint(event.clientX, event.clientY);
      dropTarget.current = dropTargetAt(
        event.clientX,
        event.clientY,
        dragState.paneId,
        split.current,
        true,
      );
      setDragging({ paneId: dragState.paneId, target: dropTarget.current });
    };
    const onEnd = () => {
      const dragState = press.current;
      press.current = null;
      if (dragState === null || !dragState.active) return;
      const target = dropTarget.current;
      dropTarget.current = null;
      clearDragGhostPoint();
      setDragging(null);
      if (target !== null) dropLatest.current(dragState.paneId, target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      clearDragGhostPoint();
    };
  }, []);

  return { dragging, startPaneDrag, startListPaneDrag, consumeDraggedClick };
}
