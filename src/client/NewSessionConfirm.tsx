import { Confirm } from "./Confirm";

type NewSessionConfirmProps = {
  paneId: string;
  available: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// メニューからの /new は 1 タップで実行される。チップや直接入力は選んでから送るので、
// 確認はここだけに置く。今の会話はセッションに残っても、hwc から開き直せない。
export function NewSessionConfirm(props: NewSessionConfirmProps) {
  return (
    <Confirm
      title="新しい会話を始めますか？"
      description={
        <>
          ペイン <span class="hwc-dialog-id">{props.paneId}</span>{" "}
          で新しい会話を始めます。今の会話には hwc から戻れません。下書きと添付は残ります。
          {props.available ? null : (
            <span class="hwc-dialog-error" role="status">
              状態が変わりました。確認を閉じて、もう一度操作してください。
            </span>
          )}
        </>
      }
      confirmLabel="始める"
      disabled={!props.available}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
