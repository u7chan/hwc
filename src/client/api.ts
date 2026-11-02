import type { PaneRead } from "../server/herdr/contract";
import type { AppState } from "../server/herdr/state";

export type OutputRead = PaneRead;

// 1 回に読む行数。スマホの画面に収まる範囲に留め、全文は端末で読む。
export const OUTPUT_LINES = 200;
// 表示中のペインを読み直す間隔。状態の変化は SSE でも届くが、端末の出力は届かない。
export const OUTPUT_POLL_MS = 2_000;

export function outputUrl(paneId: string, lines: number = OUTPUT_LINES): string {
  const query = new URLSearchParams({ source: "recent", lines: String(lines) });
  return `/api/panes/${encodeURIComponent(paneId)}/output?${query.toString()}`;
}

export function toAppState(value: unknown): AppState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<AppState>;
  if (!Array.isArray(state.workspaces)) return null;
  return state as AppState;
}

export function parseAppState(data: string): AppState | null {
  try {
    return toAppState(JSON.parse(data));
  } catch {
    return null;
  }
}

export function toPaneRead(value: unknown, paneId: string): OutputRead | null {
  if (typeof value !== "object" || value === null) return null;
  const read = value as Partial<OutputRead>;
  if (read.paneId !== paneId) return null;
  if (typeof read.text !== "string") return null;
  if (typeof read.truncated !== "boolean") return null;
  if (typeof read.revision !== "number") return null;
  return { paneId, text: read.text, truncated: read.truncated, revision: read.revision };
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

export async function fetchState(signal?: AbortSignal): Promise<AppState> {
  const state = toAppState(await getJson("/api/state", signal));
  if (state === null) throw new Error("/api/state: unexpected body");
  return state;
}

export async function readOutput(paneId: string, signal?: AbortSignal): Promise<OutputRead> {
  const read = toPaneRead(await getJson(outputUrl(paneId), signal), paneId);
  if (read === null) throw new Error("output: unexpected body");
  return read;
}

export async function sendInput(paneId: string, text: string, signal?: AbortSignal): Promise<void> {
  // BFF は application/json 以外を 415 で弾く。cross-origin の simple request に落とさない。
  const response = await fetch(`/api/panes/${encodeURIComponent(paneId)}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, submit: true }),
    signal,
  });
  if (!response.ok) throw new Error(`input: ${response.status}`);
}
