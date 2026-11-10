export type SnapshotOrigin = "initial-fetch" | "stream";

// 状態の書き込み元は 1 つに保つ。初回 fetch は SSE の最初のスナップショットが届くまでの
// つなぎで、届いた後は捨てる（遅れて返った古い応答で新しい状態を上書きしない）。
export function gateSnapshot(
  writer: SnapshotOrigin,
  origin: SnapshotOrigin,
): { writer: SnapshotOrigin; apply: boolean } {
  if (origin === "stream") return { writer: "stream", apply: true };
  return { writer, apply: writer === "initial-fetch" };
}
