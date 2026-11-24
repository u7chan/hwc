import type { PaneState } from "../server/herdr/state";
import type { PaneCloseAction } from "../shared/pane-close";
import { Confirm } from "./Confirm";
import { closeFailureNotice } from "./failure-text";

type CloseConfirmProps = {
  pane: PaneState;
  action: PaneCloseAction;
  available: boolean;
  busy: boolean;
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// 実行中・要対応は失われるものを言い分ける。状態は開いた時点で固定せず、そのまま読む。
function closeCopy(pane: PaneState) {
  const id = <span class="hwc-dialog-id">{pane.id}</span>;
  switch (pane.agentStatus) {
    case "working":
      return {
        confirmLabel: "実行中でも閉じる",
        description: <>実行中です。ペイン {id} を閉じると、開いていた作業は失われます。</>,
      };
    case "blocked":
      return {
        confirmLabel: "要対応でも閉じる",
        description: <>要対応の作業があります。ペイン {id} を閉じると、その作業は失われます。</>,
      };
    default:
      return {
        confirmLabel: "閉じる",
        description: <>ペイン {id} を閉じます。開いていた作業は失われます。</>,
      };
  }
}

// 閉じたペインの作業は戻せない。実行中でも閉じられるままにして、止まったエージェントを畳めるようにする。
export function CloseConfirm(props: CloseConfirmProps) {
  const exiting = props.action === "exit";
  const copy = exiting
    ? {
        confirmLabel: "終了を要求する",
        description: (
          <>
            {props.pane.agentStatus === "working" ? "実行中です。" : ""}
            ペイン <span class="hwc-dialog-id">{props.pane.id}</span>
            のエージェントに終了を要求します。ペインとスペースは残します。
          </>
        ),
      }
    : closeCopy(props.pane);
  return (
    <Confirm
      title={exiting ? "エージェントを終了しますか？" : "ペインを閉じますか？"}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      busy={props.busy}
      available={props.available}
      failedNotice={props.failed ? closeFailureNotice(props.action) : undefined}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
