import { request, subscribe } from "./socket";
import { type AppState, type HerdrSnapshot, parseSnapshot, type StateStore } from "./state";

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

const AGENT_STATUS_EVENT = "pane.agent_status_changed";

export type SyncOptions = {
  store: StateStore;
  path?: string;
  reconnectDelayMs?: number;
  onError?: (error: Error) => void;
};

export async function loadSnapshot(options: { path?: string } = {}): Promise<HerdrSnapshot> {
  const result = await request<{ snapshot: unknown }>(
    "session.snapshot",
    {},
    { path: options.path },
  );
  return parseSnapshot(result?.snapshot);
}

function paneIds(state: AppState): string[] {
  return state.workspaces
    .flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id)))
    .sort();
}

export function startStateSync(options: SyncOptions): () => void {
  const { store } = options;
  const report = (error: unknown) =>
    options.onError?.(error instanceof Error ? error : new Error(String(error)));

  let statusStop: (() => void) | null = null;
  let subscribedPanes = "";
  let rejectedPanes: string | null = null;

  const reload = () => {
    store.refresh().catch(report);
  };

  // エージェントの状態変化は pane_id 指定でしか購読できない。存在しないペインが 1 つでも混じると
  // 購読リクエスト全体が拒否されるため、ライフサイクル購読とは別の接続に分ける。
  const connectStatus = (panes: readonly string[]) => {
    statusStop?.();
    statusStop = null;
    if (panes.length === 0) return;

    statusStop = subscribe({
      events: panes.map((pane_id) => ({ type: AGENT_STATUS_EVENT, pane_id })),
      path: options.path,
      reconnectDelayMs: options.reconnectDelayMs,
      onEvent: reload,
      // 切断中に起きた状態変化はイベントで届かない。再接続したら状態を取り直して追いつく。
      onLost: reload,
      onError: (error) => {
        // ペインが消えた可能性がある。状態を取り直し、新しいペイン集合で張り直す。
        rejectedPanes = subscribedPanes;
        subscribedPanes = "";
        report(error);
        reload();
      },
    });
  };

  const stopLifecycle = subscribe({
    events: STATE_EVENTS.map((type) => ({ type })),
    path: options.path,
    reconnectDelayMs: options.reconnectDelayMs,
    onEvent: reload,
    // 購読が切れるとイベントを取りこぼす。再接続できたら丸ごと取り直して追いつく。
    onLost: () => {},
    onStarted: reload,
    onError: report,
  });

  const unsubscribe = store.onChange((state) => {
    const panes = paneIds(state);
    const key = panes.join(",");
    if (key === subscribedPanes) return;
    // 同じペイン集合で拒否された直後に繰り返すと、取得と拒否を往復し続ける。
    if (key === rejectedPanes) return;
    subscribedPanes = key;
    rejectedPanes = null;
    connectStatus(panes);
  });

  return () => {
    unsubscribe();
    statusStop?.();
    statusStop = null;
    stopLifecycle();
  };
}
