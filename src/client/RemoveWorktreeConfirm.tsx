import { Confirm } from "./Confirm";
import { REMOVE_WORKTREE_FAILED_NOTICE } from "./failure-text";

type RemoveWorktreeConfirmProps = {
  label: string;
  checkoutPath: string | null;
  available: boolean;
  busy: boolean;
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// Herdr の TUI と同じ内容を伝える。消えるのはフォルダで、ブランチは残る。
export function RemoveWorktreeConfirm(props: RemoveWorktreeConfirmProps) {
  return (
    <Confirm
      title="ワークツリーを削除しますか？"
      description={
        <>
          チェックアウト <span class="hwc-dialog-id">{props.checkoutPath ?? props.label}</span>{" "}
          を削除し、スペースを閉じます。ブランチは残りますが、未コミット・未追跡のファイルは失われ、実行中のエージェントも終了します。
          {!props.available ? (
            <span class="hwc-dialog-error" role="status">
              状態が変わりました。確認を閉じて、もう一度操作してください。
            </span>
          ) : null}
          {props.failed ? (
            <span class="hwc-dialog-error" role="status">
              {REMOVE_WORKTREE_FAILED_NOTICE}
            </span>
          ) : null}
        </>
      }
      confirmLabel="削除する"
      busy={props.busy}
      disabled={!props.available}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
