import type { PaneState } from "../server/herdr/state";
import { Confirm } from "./Confirm";

export const CLOSE_FAILED_NOTICE = "閉じられませんでした。もう一度お試しください。";

type CloseConfirmProps = {
  pane: PaneState;
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
  const copy = closeCopy(props.pane);
  return (
    <Confirm
      title="ペインを閉じますか？"
      description={
        <>
          {copy.description}
          {props.failed ? (
            <span class="hwc-dialog-error" role="status">
              {CLOSE_FAILED_NOTICE}
            </span>
          ) : null}
        </>
      }
      confirmLabel={copy.confirmLabel}
      busy={props.busy}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
