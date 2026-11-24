// 確認の状態。対象は開いた時点のスナップショットから写して持ち、phase だけを進める。
// 開いていないことは null で表す。
export type ConfirmPhase = "confirm" | "busy" | "failed";

export type ConfirmState<T, P extends string = ConfirmPhase> = { target: T; phase: P };

// 確認を受け付けるか。対象がまだあり、結果の反映を待っていないときだけ。
// 失敗を出している間は、もう一度試せる。削除の leave（確認はもう閉じている）は受け付けない。
export function canConfirm<T, P extends string>(
  state: ConfirmState<T, P> | null,
  available: boolean,
): state is ConfirmState<T, P> {
  return state !== null && (state.phase === "confirm" || state.phase === "failed") && available;
}

// 取り消しで戻す先。結果の反映を待つ間は受け付けず（そのまま返し）、それ以外は閉じる（null）。
export function cancelConfirm<T, P extends string>(
  state: ConfirmState<T, P> | null,
): ConfirmState<T, P> | null {
  return state !== null && state.phase === "busy" ? state : null;
}
