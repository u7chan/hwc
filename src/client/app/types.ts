import type { ChatFile } from "../../server/chat/contract";
import type { ListScope } from "../scope";
import type { PaneCloseAction } from "../../shared/pane-close";
import type { ConfirmPhase } from "./confirm";
import type { GitSyncFailure } from "../requests/workspaces";
import type { DropZone, SplitView, TabSide } from "../split-view";
import type { CreateTarget } from "../CreatePane";

export type View = { split: SplitView; expanded: ReadonlySet<string> };

// 開いているプレビュー。Herdr のペインではないので、状態には載せない。shown は
// タブの選択と同じで、ペインのタブを選ぶと false に戻る。
export type PreviewTarget = { paneId: string; file: ChatFile; shown: boolean };

// 閉じる確認。後継は確認を開いた時点で決める。SSE が閉じたペインを落とした後では、
// 次のペインを引けない。後継は同じ葉（セル）の次のタブから選ぶ。
export type Closing = {
  paneId: string;
  action: PaneCloseAction;
  next: string | null;
};

export type OperationMenu = {
  target: { kind: "pane" | "workspace"; id: string };
  trigger: HTMLElement;
  // 一覧から開いたときのスコープ。一覧以外（セル・タブ・詳細）は null。
  listScope: ListScope | null;
  open: boolean;
};

// ドラッグの落とし先。中央はセルの末尾への移動、端はその方向への分割。
// kind は枠を出す側を分けるために持つ。
// タブの side は差し込み位置。gap はタブとタブの間・列の余白で、同じ葉でも
// 並べ替えたペインを選ぶ。タブの上では並べ替えだけにして選択を動かさない。
export type DropTarget =
  | { kind: "cell"; pane: string; zone: DropZone }
  | { kind: "tab"; pane: string; side: TabSide; gap: boolean };

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
// スペースを落とした後では、何を消すのかを引けない。
export type Removing = {
  workspaceId: string;
  label: string;
  checkoutPath: string | null;
};

// 削除だけは、確認を閉じた後も一覧の行が消えるアニメーションを待つ間（leave）がある。
export type RemovingPhase = ConfirmPhase | "leave";

// タブから外すアニメーション（TabBar）の対象。完了してから葉のタブへ反映する。
// successor は閉じる確認で決めた同じ葉の後継。× では省略し、removeTab の既定に任せる。
export type LeavingTab = { paneId: string; successor?: string | null };

// スペースを閉じる確認。フォルダは残るが、実行中のエージェントは終わる。
export type ClosingSpace = {
  workspaceId: string;
  label: string;
  path: string | null;
};

// 作成ダイアログ。何を作るかは target が決める。
export type CreatingPane = {
  paneId: string;
  target: CreateTarget;
};
