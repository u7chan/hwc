import type { ComponentChildren } from "preact";
import { DialogShell } from "./Dialog";

// 対象が消えた・変わったことを、確認の本文の末尾に出す。どのダイアログでも同じ言い方をする。
export const CONFIRM_CHANGED_NOTICE =
  "状態が変わりました。確認を閉じて、もう一度操作してください。";

type ConfirmProps = {
  title: string;
  description: ComponentChildren;
  confirmLabel: string;
  // 実行中は操作を受け付けない。結果の反映を 1 回に保つ。
  busy?: boolean;
  disabled?: boolean;
  // 対象がまだあるか。false なら理由を出し、確認を押せなくする。
  available?: boolean;
  // 失敗の文言。渡したときだけ、結果の欄に出す。
  failedNotice?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

// 破壊的な操作はここで一度止める。ブラウザの確認ダイアログは見た目を揃えられない。
export function Confirm(props: ConfirmProps) {
  const available = props.available ?? true;
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
        {available ? null : (
          <span class="hwc-dialog-error" role="status">
            {CONFIRM_CHANGED_NOTICE}
          </span>
        )}
        {props.failedNotice === undefined ? null : (
          <span class="hwc-dialog-error" role="status">
            {props.failedNotice}
          </span>
        )}
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
          disabled={props.busy || props.disabled || !available}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
