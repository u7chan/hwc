// タブ内に作れるペインの上限。狭いペインは TUI の幅に依存する UI（承認ダイアログなど）を
// 壊すので、hwc から増やせる枚数を 2x2 までに抑える。
export const MAX_PANES_PER_TAB = 4;

// シェルペインの前景プロセス。Herdr のイベントには載らず、スナップショットにも無いので、
// 表示する側が都度読む。running は「何かが動いている」、command は表示用のコマンド行。
// 前景グループだけ分かってコマンド行が読めないこともあるので、command は null を許す。
export type PaneProcess = { running: boolean; command: string | null };

export const IDLE_PANE_PROCESS: PaneProcess = { running: false, command: null };

export function parsePaneProcess(value: unknown): PaneProcess {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return IDLE_PANE_PROCESS;
  }
  const record = value as Record<string, unknown>;
  const command = record.command;
  return {
    running: record.running === true,
    command: typeof command === "string" && command !== "" ? command : null,
  };
}
