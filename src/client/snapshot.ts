import type { ConnectionStatus } from "./connection";

export type SnapshotOrigin = "initial-fetch" | "stream";

// 次のスナップショットが新しい観測の最初か。接続が `live` でない描画を見た時点で
// 立て、スナップショットを 1 枚処理したら下ろす。切断中に終わったペインを
// 「この端末が観測した完了」にしないため。
export function nextObservation(previous: boolean, connection: ConnectionStatus): boolean {
  return previous || connection !== "live";
}

// 状態の書き込み元は 1 つに保つ。初回 fetch は SSE の最初のスナップショットが届くまでの
// つなぎで、届いた後は捨てる（遅れて返った古い応答で新しい状態を上書きしない）。
export function gateSnapshot(
  writer: SnapshotOrigin,
  origin: SnapshotOrigin,
): { writer: SnapshotOrigin; apply: boolean } {
  if (origin === "stream") return { writer: "stream", apply: true };
  return { writer, apply: writer === "initial-fetch" };
}
