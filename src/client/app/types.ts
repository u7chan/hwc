import type { ChatFile } from "../../server/chat/contract";
import type { PaneCloseAction } from "../../shared/pane-close";
import type { GitSyncFailure } from "../api";
import type { DropZone, SplitView } from "../split-view";

export type View = { split: SplitView; expanded: ReadonlySet<string> };

// 開いているプレビュー。Herdr のペインではないので、状態には載せない。shown は
// タブの選択と同じで、ペインのタブを選ぶと false に戻る（ADR 0051）。
export type PreviewTarget = { paneId: string; file: ChatFile; shown: boolean };

// 閉じる確認。後継は確認を開いた時点で決める。SSE が閉じたペインを落とした後では、
// 次のペインを引けないため。
export type Closing = {
  paneId: string;
  action: PaneCloseAction;
  next: string | null;
  phase: "confirm" | "busy" | "failed";
};

export type OperationMenu = {
  target: { kind: "pane" | "workspace"; id: string };
  trigger: HTMLElement;
  fromList: boolean;
  open: boolean;
};

// ドラッグの落とし先。中央は入れ替え、端はその方向への分割（ADR 0061）。
// kind は落とし先がセルか固定ゾーンのタブか。枠を出す側を分けるために持つ（ADR 0064）。
export type DropTarget = { kind: "cell" | "tab"; pane: string; zone: DropZone };

// メニューを閉じても続く操作。busy はメニューの外に置き、開き直しても実行中を出す。
export type GitAction =
  | { workspaceId: string; action: "fetch" | "pull"; phase: "busy" }
  | {
      workspaceId: string;
      action: "fetch" | "pull";
      phase: "failed";
      error: GitSyncFailure;
    };

// 削除の確認。対象の名前とパスは開いた時点のスナップショットから取る。SSE が
// スペースを落とした後では、何を消すのかを引けない。leave は削除が確定し、一覧から
// 対象が消えるアニメーションを見せている間。確認ダイアログは閉じる。
export type Removing = {
  workspaceId: string;
  label: string;
  checkoutPath: string | null;
  phase: "confirm" | "busy" | "leave" | "failed";
};

// タブから外すアニメーション（TabBar）の対象。完了してから openTabs へ反映する。
// successor は閉じる確認で決めた後継。× では省略し、removeTab の既定に任せる。
export type LeavingTab = { paneId: string; successor?: string | null };

// 重複したネイティブスペースを閉じる確認。フォルダは残るが、実行中のエージェントは終わる。
export type ClosingSpace = {
  workspaceId: string;
  label: string;
  path: string | null;
  phase: "confirm" | "busy" | "failed";
};

// 作成ダイアログ。ワークツリーを作る場合は、モデル一覧の取得元になる起点スペースの ID も持つ。
// start は、作らずに既存のシェルペインで起動する。
export type CreatingPane = {
  paneId: string;
  worktreeWorkspaceId: string | null;
  start: boolean;
};
