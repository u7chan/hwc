import { Confirm } from "./Confirm";
import { CLOSE_SPACE_FAILED_NOTICE } from "./failure-text";

type CloseSpaceConfirmProps = {
  label: string;
  path: string | null;
  available: boolean;
  busy: boolean;
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// スペースを閉じるだけで、フォルダは残る。linked worktree の削除とは文言を分け、
// 実行中のエージェントが終わることだけは省かない。
export function CloseSpaceConfirm(props: CloseSpaceConfirmProps) {
  return (
    <Confirm
      title="スペースを閉じますか？"
      description={
        <>
          スペース <span class="hwc-dialog-id">{props.path ?? props.label}</span> を閉じます。
          実行中のエージェントも終了しますが、チェックアウトのファイルは残ります。
        </>
      }
      confirmLabel="閉じる"
      busy={props.busy}
      available={props.available}
      failedNotice={props.failed ? CLOSE_SPACE_FAILED_NOTICE : undefined}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
