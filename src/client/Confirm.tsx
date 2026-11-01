import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

type ConfirmProps = {
  title: string;
  description: ComponentChildren;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

// 破壊的な操作はここで一度止める。ブラウザの確認ダイアログは見た目を揃えられない。
export function Confirm(props: ConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div class="hwc-dialog-layer">
      <div class="hwc-dialog-backdrop" onPointerDown={props.onCancel} />
      <div class="hwc-dialog-wrap">
        <div
          class="hwc-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="hwc-dialog-title"
          aria-describedby="hwc-dialog-text"
        >
          <h2 class="hwc-dialog-title" id="hwc-dialog-title">
            {props.title}
          </h2>
          <p class="hwc-dialog-text" id="hwc-dialog-text">
            {props.description}
          </p>
          <div class="hwc-dialog-actions">
            <button
              type="button"
              class="hwc-dialog-button hwc-dialog-cancel"
              ref={cancel}
              onClick={props.onCancel}
            >
              キャンセル
            </button>
            <button
              type="button"
              class="hwc-dialog-button hwc-dialog-confirm"
              onClick={props.onConfirm}
            >
              {props.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
