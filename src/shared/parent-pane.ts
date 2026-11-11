import type { PaneState, WorkspaceState } from "../server/herdr/state";

// スペースの親。左端のタブから順に、最初のエージェントのペイン。Herdr の snapshot には
// 作成順が無いので、一覧の並び（左端）で代用する。最初のペインがシェルなら次を見る。
// ファビコン（クライアント）と完了通知（BFF）で同じ判定を使うので、状態の型だけを
// import type で受け、状態を組み立てるモジュールには置かない（クライアントのバンドルに
// node:path や pane-times の実行時 import が入る）。
export function parentPaneOf(workspace: WorkspaceState): PaneState | null {
  for (const tab of workspace.tabs) {
    for (const pane of tab.panes) {
      if (pane.agent !== null) return pane;
    }
  }
  return null;
}
