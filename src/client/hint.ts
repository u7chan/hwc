import type { TargetedFocusEvent, TargetedMouseEvent, TargetedPointerEvent } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isCopyShim } from "./copy";

// 開いた理由。触れて開いたものは指が離れると閉じ、押して開いたものは外側を押すまで残す。
type Open = "hover" | "pinned" | null;

// パネルは画面端からこれだけ離して止める。
const EDGE = 8;

// パネルの左端。幅は右端起点で、右端を揃えると左へはみ出す位置では左端を揃える。
// それでも入らないときだけ、見えている範囲へ寄せる。
export function hintLeft(
  anchorLeft: number,
  anchorRight: number,
  panelWidth: number,
  viewLeft: number,
  viewWidth: number,
): number {
  const room = Math.min(panelWidth, viewWidth - EDGE * 2);
  const min = viewLeft + EDGE;
  const max = viewLeft + viewWidth - EDGE - room;
  const alignedRight = anchorRight - room;
  const preferred = alignedRight < min ? anchorLeft : alignedRight;
  return Math.min(Math.max(preferred, min), max);
}

// 入力欄まわりの情報札は、PC でもタッチでも同じ内容を開けるようにする。標準の title は
// タッチで出ず、キーボードからも読めないので、配置と閉じ方をここに集める。
export function useHint() {
  const [open, setOpen] = useState<Open>(null);
  const root = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useLayoutEffect(() => {
    if (open === null || root.current === null || panel.current === null) return;
    const anchor = root.current;
    const popup = panel.current;
    const viewport = window.visualViewport;
    // 上に入る高さが足りなければ下へ回し、はみ出す分はパネル側をスクロールさせる。
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const above = Math.max(0, rect.top - top - EDGE);
      const below = Math.max(0, top + height - rect.bottom - EDGE);
      const placement = above >= below ? "above" : "below";
      popup.dataset.placement = placement;
      popup.style.maxHeight = `${placement === "above" ? above : below}px`;
      const panelLeft = hintLeft(
        rect.left,
        rect.right,
        popup.offsetWidth,
        viewport?.offsetLeft ?? 0,
        viewport?.width ?? window.innerWidth,
      );
      popup.style.left = `${panelLeft - rect.left}px`;
      popup.style.right = "auto";
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [open]);

  useEffect(() => {
    if (open === null) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // パネルの中にフォーカスがあるまま閉じると、行き場が無くなる。
      if (panel.current?.contains(document.activeElement))
        root.current?.querySelector("button")?.focus();
      setOpen(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return {
    open,
    panelId,
    root,
    panel,
    wrapperProps: {
      onPointerEnter: (event: TargetedPointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse") setOpen((current) => current ?? "hover");
      },
      onPointerLeave: (event: TargetedPointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse" && !panel.current?.contains(document.activeElement))
          setOpen((current) => (current === "hover" ? null : current));
      },
      // パネルの中のボタンへ移っただけでは閉じない。外へ抜けたら閉じる。
      onFocusOut: (event: TargetedFocusEvent<HTMLElement>) => {
        // http のコピーは一時 textarea へフォーカスを移す。操作の続きなので閉じない。
        if (isCopyShim(event.relatedTarget)) return;
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(null);
      },
    },
    triggerProps: {
      onFocus: (event: TargetedFocusEvent<HTMLElement>) => {
        if (event.currentTarget.matches(":focus-visible")) setOpen((current) => current ?? "hover");
      },
      onBlur: (event: TargetedFocusEvent<HTMLElement>) => {
        if (event.relatedTarget !== null) {
          if (!root.current?.contains(event.relatedTarget as Node)) setOpen(null);
        } else setOpen((current) => (current === "hover" ? null : current));
      },
      onClick: (event: TargetedMouseEvent<HTMLElement>) => {
        // 省略された名前を範囲選択している間は、押しても閉じない。
        const selection = window.getSelection();
        if (!selection?.isCollapsed && event.currentTarget.contains(selection?.anchorNode ?? null))
          return;
        setOpen((current) => (current === "pinned" ? null : "pinned"));
      },
    },
    panelTabIndex: open === null ? -1 : 0,
  };
}
