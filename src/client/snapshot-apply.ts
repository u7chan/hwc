import type { AppState } from "../server/herdr/state";
import type { PaneCloseAction } from "../shared/pane-close";
import type { ConfirmPhase, ConfirmState } from "./app/confirm";
import type { RemovingPhase } from "./app/types";
import { findPane } from "./select";
import { leafOfPane, type SplitNode } from "./split-view";

// 届いたスナップショットをどう扱うか。消える演出の途中なら保留し、演出が始まっていなければ
// 先に始め、演出できない対象ならその場で適用する。
export type SnapshotApply =
  | { kind: "apply" }
  | { kind: "hold" }
  | { kind: "leave-space" }
  | { kind: "leave-tab"; paneId: string; successor: string | null }
  | { kind: "apply-now" };

// 判断に要るのは、演出中の対象と、届いたスナップショットの中身、そしてペインがタブとして
// 開いているか。いま表示している状態と保留中のものは判断に使わない（結果であって入力ではない）。
export type SnapshotApplyInput = {
  next: AppState;
  removing: ConfirmState<{ workspaceId: string }, RemovingPhase> | null;
  closing: ConfirmState<
    { paneId: string; action: PaneCloseAction; next: string | null },
    ConfirmPhase
  > | null;
  leavingTab: boolean;
  layout: SplitNode | null;
};

export function decideSnapshotApply(input: SnapshotApplyInput): SnapshotApply {
  const { next, removing, closing, leavingTab, layout } = input;
  // 画面から消える対象のアニメーションが途中で切り落とされないよう、その間だけ保留する。
  if (removing?.phase === "leave" || leavingTab) return { kind: "hold" };
  // 応答より先にスペースが消えたスナップショットが届くことがある。対象を消して見せてから
  // 適用する。
  if (
    removing?.phase === "busy" &&
    !next.workspaces.some((workspace) => workspace.id === removing.target.workspaceId)
  ) {
    return { kind: "leave-space" };
  }
  // ペインを閉じる要求の応答より先に、ペインが消えたスナップショットが届くことがある。
  // 消えるタブを先に見せてから適用する。
  if (
    closing?.phase === "busy" &&
    closing.target.action === "close" &&
    findPane(next, closing.target.paneId) === null
  ) {
    // タブとして開いていないペインはアニメーションできない。保留だけ残すと次の
    // スナップショットまで一覧が古いままになるので、その場で適用する。
    if (leafOfPane(layout, closing.target.paneId) === null) return { kind: "apply-now" };
    return { kind: "leave-tab", paneId: closing.target.paneId, successor: closing.target.next };
  }
  return { kind: "apply" };
}
