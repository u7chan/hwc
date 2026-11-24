import type { ComponentChildren } from "preact";
import { confirmView } from "./confirm-view";
import { DialogShell } from "./Dialog";

type ConfirmProps = {
  title: string;
  description: ComponentChildren;
  confirmLabel: string;
  // 実行中は操作を受け付けない。結果の反映を 1 回に保つ。
  busy?: boolean;
  // 対象がまだあるか。false なら理由を出し、確認を押せなくする。
  available?: boolean;
  // 失敗の文言。渡したときだけ、結果の欄に出す。
  failedNotice?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

// 破壊的な操作はここで一度止める。ブラウザの確認ダイアログは見た目を揃えられない。
export function Confirm(props: ConfirmProps) {
  const view = confirmView(props);
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
        {view.changedNotice === null ? null : (
          <span class="hwc-dialog-error" role="status">
            {view.changedNotice}
          </span>
        )}
        {view.failedNotice === null ? null : (
          <span class="hwc-dialog-error" role="status">
            {view.failedNotice}
          </span>
        )}
      </p>
      <div class="hwc-dialog-actions">
        <button
          type="button"
          class="hwc-dialog-button hwc-dialog-cancel"
          data-autofocus
          disabled={view.cancelDisabled}
          onClick={props.onCancel}
        >
          キャンセル
        </button>
        <button
          type="button"
          class="hwc-dialog-button hwc-dialog-confirm"
          disabled={view.confirmDisabled}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
