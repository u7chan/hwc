// 対象が消えた・変わったことを、確認の本文の末尾に出す。どのダイアログでも同じ言い方をする。
const CHANGED_NOTICE = "状態が変わりました。確認を閉じて、もう一度操作してください。";

export type ConfirmView = {
  changedNotice: string | null;
  failedNotice: string | null;
  cancelDisabled: boolean;
  confirmDisabled: boolean;
};

export function confirmView(props: {
  busy?: boolean;
  disabled?: boolean;
  available?: boolean;
  failedNotice?: string;
}): ConfirmView {
  const busy = props.busy ?? false;
  const available = props.available ?? true;
  return {
    changedNotice: available ? null : CHANGED_NOTICE,
    failedNotice: props.failedNotice ?? null,
    cancelDisabled: busy,
    confirmDisabled: busy || (props.disabled ?? false) || !available,
  };
}
