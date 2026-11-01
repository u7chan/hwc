import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

type DialogShellProps = {
  role: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  className?: string;
  onClose: () => void;
  children: ComponentChildren;
};

// 出方・閉じ方・フォーカスの扱いを 1 か所にまとめる。中身だけ画面ごとに差し替える。
export function DialogShell(props: DialogShellProps) {
  const card = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  // 開いたときに焦点を移し、閉じたら元の場所へ戻す。
  useEffect(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = card.current?.querySelector<HTMLElement>("[data-autofocus]") ?? card.current;
    target?.focus();
    return () => {
      restore.current?.focus?.();
    };
  }, []);

  // Esc は開いたままの handler を呼ぶ。依存に入れて、差し替わったら貼り直す。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <div class="hwc-dialog-layer">
      <div class="hwc-dialog-backdrop" onPointerDown={props.onClose} />
      <div class="hwc-dialog-wrap">
        <div
          ref={card}
          class={props.className ? `hwc-dialog ${props.className}` : "hwc-dialog"}
          role={props.role}
          aria-modal="true"
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
