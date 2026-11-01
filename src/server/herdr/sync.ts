import { subscribe, type SubscriptionSpec } from "./socket";
import type { AppState, StateStore } from "./state";

// layout / scroll / output / token は state に載せない。購読すると出力のたびにスナップショットを
// 取り直すことになり、費用に見合わない。
const STATE_EVENTS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
] as const;

// エージェントの状態変化は pane_id を指定しないと購読できない。ペインの増減に合わせて張り直す。
const AGENT_STATUS_EVENT = "pane.agent_status_changed";

export type SyncOptions = {
  store: StateStore;
  path?: string;
  reconnectDelayMs?: number;
  onError?: (error: Error) => void;
};

function paneIds(state: AppState): string[] {
  return state.workspaces
    .flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id)))
    .sort();
}

export function startStateSync(options: SyncOptions): () => void {
  const { store } = options;
  let stop: (() => void) | null = null;
  let subscribedPanes = "";

  const reload = () => {
    store.refresh().catch((error: unknown) => {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  };

  const connect = (panes: readonly string[]) => {
    stop?.();
    const events: SubscriptionSpec[] = [
      ...STATE_EVENTS.map((type) => ({ type })),
      ...panes.map((pane_id) => ({ type: AGENT_STATUS_EVENT, pane_id })),
    ];
    stop = subscribe({
      events,
      path: options.path,
      reconnectDelayMs: options.reconnectDelayMs,
      onEvent: reload,
      // 購読が切れるとイベントを取りこぼす。再接続できたら丸ごと取り直して追いつく。
      onLost: () => {},
      onStarted: reload,
      onError: options.onError,
    });
  };

  const unsubscribe = store.onChange((state) => {
    const panes = paneIds(state);
    const key = panes.join(",");
    if (key === subscribedPanes) return;
    subscribedPanes = key;
    connect(panes);
  });

  connect([]);

  return () => {
    unsubscribe();
    stop?.();
    stop = null;
  };
}
