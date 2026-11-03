import type { AppState } from "../server/herdr/state";
import { findPaneRow, type PaneRow } from "./select";

// 窓口は「そのスペースで最後にメッセージを送ったペイン」。端末ごとの記憶なので Herdr には持たせない。
export type SentPane = { paneId: string; at: number };

export const SENT_PANE_STORAGE_KEY = "hwc-sent-pane";

const NO_SENT: ReadonlyMap<string, SentPane> = new Map();

// 壊れた値と、形の合わない項目は捨てる。窓口が戻るだけで一覧は使える。
export function parseSentPanes(raw: string | null): ReadonlyMap<string, SentPane> {
  if (raw === null) return NO_SENT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NO_SENT;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_SENT;

  const sent = new Map<string, SentPane>();
  for (const [workspaceId, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { paneId, at } = entry as { paneId?: unknown; at?: unknown };
    if (typeof paneId !== "string" || paneId === "") continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    sent.set(workspaceId, { paneId, at });
  }
  return sent;
}

// 送信が通ったときだけ呼ぶ。シェルのペインは窓口にしない（次に送る相手が決まらない）。
export function recordSent(
  sent: ReadonlyMap<string, SentPane>,
  row: PaneRow | null,
  at: number,
): ReadonlyMap<string, SentPane> {
  if (row === null || row.pane.agent === null) return sent;
  return new Map(sent).set(row.workspace.id, { paneId: row.pane.id, at });
}

// 窓口の行。新しい順に返す。オブジェクトのキー順に頼ると、同じスペースへ送り直したときに
// 並びが変わらない。要対応は要対応の側へ回すので、ここでは出さない。
export function sentPanes(
  state: AppState,
  sent: ReadonlyMap<string, SentPane>,
): readonly PaneRow[] {
  const windows: { row: PaneRow; at: number }[] = [];
  for (const [workspaceId, entry] of sent) {
    const row = findPaneRow(state, entry.paneId);
    if (row === null || row.workspace.id !== workspaceId) continue;
    if (row.pane.agent === null) continue;
    const status = row.pane.agentStatus;
    if (status === "blocked" || status === "unknown") continue;
    windows.push({ row, at: entry.at });
  }
  return windows.sort((a, b) => b.at - a.at).map((window) => window.row);
}

// 保存するのは、いまも居るエージェントのペインを指す窓口だけ。
export function sentForSave(
  state: AppState,
  sent: ReadonlyMap<string, SentPane>,
): Record<string, SentPane> {
  const record: Record<string, SentPane> = {};
  for (const [workspaceId, entry] of sent) {
    const row = findPaneRow(state, entry.paneId);
    if (row === null || row.workspace.id !== workspaceId) continue;
    if (row.pane.agent === null) continue;
    record[workspaceId] = { paneId: entry.paneId, at: entry.at };
  }
  return record;
}
