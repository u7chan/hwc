import type { PaneClient } from "./herdr/panes";
import { type AppState, findPane, type StateStore } from "./herdr/state";

// 終了要求は `/quit` を送れたことしか保証しない。シェルに戻るまで待ち、
// 終了したエージェントの最後の画面を消す。待ち続けないよう上限を置く。
export const EXIT_CLEAR_TIMEOUT_MS = 30_000;

type PendingClear = {
  agent: string;
  stop: () => void;
  timer: ReturnType<typeof setTimeout>;
};

// エージェントを終了したペインは、いずれ状態から agent が消える。その時点で旧画面を消し、
// プロンプトだけのシェルとして見せる。
export function createExitCleanup(
  store: Pick<StateStore, "get" | "onChange">,
  panes: Pick<PaneClient, "clear">,
  timeoutMs = EXIT_CLEAR_TIMEOUT_MS,
): (paneId: string) => void {
  const pending = new Map<string, PendingClear>();

  const clear = (paneId: string) => {
    // 終了そのものは済んでいる。消せなくても再試行は求めない。
    panes.clear({ paneId }).catch(() => {});
  };

  const finish = (paneId: string) => {
    const entry = pending.get(paneId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.stop();
    pending.delete(paneId);
  };

  const observe = (paneId: string, state: AppState) => {
    const entry = pending.get(paneId);
    if (entry === undefined) return;
    const pane = findPane(state, paneId);
    // ペインごと消えた・別のエージェントに変わった。終了したエージェントの画面ではない。
    if (pane === null || (pane.agent !== null && pane.agent !== entry.agent)) {
      finish(paneId);
      return;
    }
    if (pane.agent !== null) return;
    finish(paneId);
    clear(paneId);
  };

  return (paneId) => {
    if (pending.has(paneId)) return;
    const pane = findPane(store.get(), paneId);
    if (pane === null) return;
    if (pane.agent === null) {
      // 応答を待つ間に終わっていた。旧画面だけを残さない。
      clear(paneId);
      return;
    }

    let stop: (() => void) | null = null;
    pending.set(paneId, {
      agent: pane.agent,
      stop: () => stop?.(),
      timer: setTimeout(() => finish(paneId), timeoutMs),
    });
    stop = store.onChange((state) => observe(paneId, state));
    // 購読が同期的に解決した場合、解除の口は finish の時点でまだ無い。
    if (!pending.has(paneId)) stop();
  };
}
