import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export const MENU_ID = "hwc-operation-menu";
export const MENU_GAP = 4;
export const MENU_MARGIN = 8;
export const MENU_MIN_WIDTH = 220;

export type MenuPlacement = { top: number; right: number };

export function menuPlacement(
  rect: { bottom: number; right: number },
  viewport: { width: number; height: number },
  height: number,
  width = MENU_MIN_WIDTH,
): MenuPlacement {
  const top = Math.max(
    MENU_MARGIN,
    Math.min(rect.bottom + MENU_GAP, viewport.height - height - MENU_MARGIN),
  );
  const right = Math.max(
    MENU_MARGIN,
    Math.min(viewport.width - rect.right, viewport.width - width - MENU_MARGIN),
  );
  return { top, right };
}

type MenuProps = {
  label: string;
  trigger: HTMLElement;
  open: boolean;
  onClose: () => void;
  onExited: () => void;
  closeOnScroll?: boolean;
  children: ComponentChildren;
};

export function Menu(props: MenuProps) {
  const { trigger, open, onClose, onExited, closeOnScroll = false } = props;
  const card = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement>({
    top: MENU_MARGIN,
    right: MENU_MARGIN,
  });

  // 文言の折り返しや会話取得後の注記で大きさが変わるため、項目数から高さを推測しない。
  useLayoutEffect(() => {
    const node = card.current;
    if (node === null) return;
    const measure = () => {
      const next = menuPlacement(
        trigger.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        node.offsetHeight,
        node.offsetWidth,
      );
      setPlacement((current) =>
        current.top === next.top && current.right === next.right ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [trigger]);

  useLayoutEffect(() => {
    const node = card.current;
    if (node === null) return;
    if (open) {
      const first = node.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
      (first ?? node).focus({ preventScroll: true });
    } else if (node.contains(document.activeElement) || document.activeElement === document.body) {
      trigger.focus({ preventScroll: true });
    }
  }, [open, trigger]);

  // CSS の完了を待ってから外す。動きを減らす設定では animation が無く、その場で外れる。
  useLayoutEffect(() => {
    if (open) return;
    let active = true;
    const animations = card.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (active) onExited();
    });
    return () => {
      active = false;
    };
  }, [open, onExited]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const close = () => onClose();
    // トリガーを動かさない会話の自動追従や、メニュー内のスクロールでは閉じない。
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.contains(trigger)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    if (closeOnScroll) window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      if (closeOnScroll) window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose, closeOnScroll, trigger]);

  return (
    <>
      {open ? <div class="hwc-menu-backdrop" onPointerDown={onClose} /> : null}
      <div
        id={MENU_ID}
        ref={card}
        class="hwc-menu"
        data-open={open}
        role="menu"
        aria-label={props.label}
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
        style={{ top: `${placement.top}px`, right: `${placement.right}px` }}
      >
        {props.children}
      </div>
    </>
  );
}
