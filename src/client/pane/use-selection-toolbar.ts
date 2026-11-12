import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import type { SelectionToolbarState } from "../SelectionToolbar";
import { readSelectionAnchor } from "../selection-toolbar";

export type UseSelectionToolbar = {
  selectionToolbar: SelectionToolbarState | null;
  quoting: RefObject<boolean>;
  // 引用として取り込んだあと。選択が変わるまで出し直さず、選択も消す。
  dismissSelection: () => void;
  closeToolbar: () => void;
};

// スマホは選択メニューを差し替えられない。選択ツールバーはポインタを持つ画面だけに出す。
// 端末の性質は途中で変わらないので、最初の判定を使い回す。
let touchOnly: boolean | null = null;
function touchFirst(): boolean {
  touchOnly ??=
    window.matchMedia("(hover: none)").matches || window.matchMedia("(pointer: coarse)").matches;
  return touchOnly;
}

// 選択ツールバーは、選択の始まりと終わりがスクロール領域の中にあるときだけ出す。
// マウスのドラッグ中は selectionchange が動くたびに発火するので評価せず、ボタンを
// 離した pointerup で確定した選択を見る。キーボードの選択変更はそのまま拾う。
// スクロール・リサイズでは位置を追い、選択が領域の外へ出たら閉じる。
export function useSelectionToolbar(options: {
  paneId: string;
  scroller: RefObject<HTMLDivElement | null>;
  frame: RefObject<HTMLDivElement | null>;
}): UseSelectionToolbar {
  const { paneId, scroller, frame } = options;
  // 閉じたあとも短い遷移の間だけ state に残す。dismissed は Esc や外側の押下で
  // 閉じたあと、選択が変わるまで出し直さないための印。
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null);
  const dismissed = useRef(false);
  // 選択ツールバーを出している間は自動追従を止める。購読を張り直さずに読むため ref に写す。
  const quoting = useRef(false);
  quoting.current = selectionToolbar !== null;

  const close = () => {
    setSelectionToolbar((current) => (current === null ? null : { ...current, open: false }));
  };

  const dismissSelection = () => {
    dismissed.current = true;
    document.getSelection()?.removeAllRanges();
    close();
  };

  useEffect(() => {
    const scrollerElement = scroller.current;
    const frameElement = frame.current;
    if (scrollerElement === null || frameElement === null) return;
    if (touchFirst()) {
      setSelectionToolbar(null);
      return;
    }

    dismissed.current = false;
    setSelectionToolbar(null);
    let dragging = false;
    let frameRequest = 0;

    const refresh = () => {
      if (dragging || dismissed.current) return;
      const anchor = readSelectionAnchor(scrollerElement, frameElement);
      if (anchor === null) close();
      else setSelectionToolbar({ anchor, open: true });
    };
    const scheduleRefresh = () => {
      if (frameRequest !== 0) return;
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        refresh();
      });
    };
    const onSelectionChange = () => {
      dismissed.current = false;
      refresh();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-selection-toolbar]") !== null) {
        return;
      }
      dragging = true;
      dismissed.current = true;
      close();
    };
    const stopDragging = () => {
      if (!dragging) return;
      dragging = false;
      refresh();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismissed.current = true;
      close();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", stopDragging);
    document.addEventListener("pointercancel", stopDragging);
    document.addEventListener("keydown", onKeyDown);
    // 窓の外で離すと pointerup が来ない。次のキーボード選択までドラッグ中のままにしない。
    window.addEventListener("blur", stopDragging);
    scrollerElement.addEventListener("scroll", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    return () => {
      if (frameRequest !== 0) cancelAnimationFrame(frameRequest);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", stopDragging);
      document.removeEventListener("pointercancel", stopDragging);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", stopDragging);
      scrollerElement.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
    };
  }, [paneId]);

  return {
    selectionToolbar,
    quoting,
    dismissSelection,
    closeToolbar: () => setSelectionToolbar(null),
  };
}
