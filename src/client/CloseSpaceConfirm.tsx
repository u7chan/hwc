import { Confirm } from "./Confirm";

export const CLOSE_SPACE_FAILED_NOTICE = "閉じられませんでした。Herdr 側の状態を確認してください。";

type CloseSpaceConfirmProps = {
  label: string;
  path: string | null;
  available: boolean;
  busy: boolean;
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// 重複したネイティブスペースを閉じる。フォルダは残るので、linked worktree の削除とは
// 文言を分ける。実行中のエージェントが終わることだけは省かない。
export function CloseSpaceConfirm(props: CloseSpaceConfirmProps) {
  return (
    <Confirm
      title="スペースを閉じますか？"
      description={
        <>
          スペース <span class="hwc-dialog-id">{props.path ?? props.label}</span> を閉じます。
          実行中のエージェントも終了しますが、チェックアウトのファイルは残ります。
          {!props.available ? (
            <span class="hwc-dialog-error" role="status">
              状態が変わりました。確認を閉じて、もう一度操作してください。
            </span>
          ) : null}
          {props.failed ? (
            <span class="hwc-dialog-error" role="status">
              {CLOSE_SPACE_FAILED_NOTICE}
            </span>
          ) : null}
        </>
      }
      confirmLabel="閉じる"
      busy={props.busy}
      disabled={!props.available}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
