import type { ComponentChildren } from "preact";
import { DialogShell } from "./Dialog";

type ConfirmProps = {
  title: string;
  description: ComponentChildren;
  confirmLabel: string;
  // 実行中は操作を受け付けない。結果の反映を 1 回に保つ。
  busy?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// 破壊的な操作はここで一度止める。ブラウザの確認ダイアログは見た目を揃えられない。
export function Confirm(props: ConfirmProps) {
  return (
    <DialogShell
      role="alertdialog"
      labelledBy="hwc-dialog-title"
      describedBy="hwc-dialog-text"
      onClose={props.onCancel}
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
          data-autofocus
          disabled={props.busy}
          onClick={props.onCancel}
        >
          キャンセル
        </button>
        <button
          type="button"
          class="hwc-dialog-button hwc-dialog-confirm"
          disabled={props.busy || props.disabled}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
