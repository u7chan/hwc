import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";

type DialogShellProps = {
  role: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  className?: string;
  open?: boolean;
  onClose: () => void;
  onExited?: () => void;
  children: ComponentChildren;
};

// 出方・閉じ方・フォーカスの扱いを 1 か所にまとめる。中身だけ画面ごとに差し替える。
export function DialogShell(props: DialogShellProps) {
  const open = props.open ?? true;
  const card = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const node = card.current;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node;
    target?.focus({ preventScroll: true });
    return () => {
      if (node?.contains(document.activeElement) || document.activeElement === document.body) {
        restore.current?.focus({ preventScroll: true });
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (open) return;
    if (
      card.current?.contains(document.activeElement) ||
      document.activeElement === document.body
    ) {
      restore.current?.focus({ preventScroll: true });
    }
    // 消える間は操作できなくし、CSS の完了後に外す。動きを減らす設定では直ちに外す。
    let active = true;
    const animations = card.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (active) props.onExited?.();
    });
    return () => {
      active = false;
    };
  }, [open, props.onExited]);

  // Esc は開いたままの handler を呼ぶ。依存に入れて、差し替わったら貼り直す。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, props.onClose]);

  return (
    <div class="hwc-dialog-layer" data-open={open}>
      <div class="hwc-dialog-backdrop" onPointerDown={open ? props.onClose : undefined} />
      <div class="hwc-dialog-wrap">
        <div
          ref={card}
          class={props.className ? `hwc-dialog ${props.className}` : "hwc-dialog"}
          role={props.role}
          aria-modal="true"
          aria-hidden={!open}
          inert={!open}
          aria-labelledby={props.labelledBy}
          aria-describedby={props.describedBy}
          tabIndex={-1}
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
