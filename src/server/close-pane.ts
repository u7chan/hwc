import { type PaneCloseAction, paneCloseAction } from "../shared/pane-close";
import type { PaneClient } from "./herdr/panes";
import type { StateStore } from "./herdr/state";

export function createPaneCloser(store: StateStore, panes: Pick<PaneClient, "close" | "exit">) {
  let pending: Promise<unknown> = Promise.resolve();

  return (paneId: string, action: PaneCloseAction) => {
    // 同時に届いた close が同じ枚数を見て、最後の 1 枚まで削除しないようにする。
    const result = pending.then(async () => {
      const state = await store.refresh();
      const allowed = paneCloseAction(state, paneId);
      if (allowed === null) return "missing";
      if (allowed !== action) return "changed";
      await panes[action]({ paneId });
      return "done";
    });
    pending = result.catch(() => {});
    return result;
  };
}
