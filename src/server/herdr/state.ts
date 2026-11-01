import type { AgentStatus, HerdrAgent, HerdrSnapshot } from "./contract";

export type { AgentStatus };

export type PaneState = {
  id: string;
  title: string | null;
  agent: string | null;
  agentStatus: AgentStatus;
  focused: boolean;
};

export type TabState = {
  id: string;
  label: string;
  agentStatus: AgentStatus;
  focused: boolean;
  panes: PaneState[];
};

export type WorkspaceState = {
  id: string;
  label: string;
  agentStatus: AgentStatus;
  focused: boolean;
  tabs: TabState[];
};

export type AppState = {
  focusedWorkspaceId: string | null;
  focusedTabId: string | null;
  focusedPaneId: string | null;
  workspaces: WorkspaceState[];
};

export function toAppState(snapshot: HerdrSnapshot): AppState {
  const agentsByPane = new Map<string, HerdrAgent>();
  for (const agent of snapshot.agents ?? []) {
    if (agent.pane_id) agentsByPane.set(agent.pane_id, agent);
  }

  const panesByTab = new Map<string, PaneState[]>();
  for (const pane of snapshot.panes ?? []) {
    const agent = agentsByPane.get(pane.pane_id);
    const panes = panesByTab.get(pane.tab_id) ?? [];
    panes.push({
      id: pane.pane_id,
      title: agent?.terminal_title_stripped ?? null,
      agent: agent?.agent ?? null,
      agentStatus: pane.agent_status ?? "unknown",
      focused: pane.focused ?? false,
    });
    panesByTab.set(pane.tab_id, panes);
  }

  const tabsByWorkspace = new Map<string, TabState[]>();
  for (const tab of snapshot.tabs ?? []) {
    const tabs = tabsByWorkspace.get(tab.workspace_id) ?? [];
    tabs.push({
      id: tab.tab_id,
      label: tab.label ?? "",
      agentStatus: tab.agent_status ?? "unknown",
      focused: tab.focused ?? false,
      panes: panesByTab.get(tab.tab_id) ?? [],
    });
    tabsByWorkspace.set(tab.workspace_id, tabs);
  }

  const workspaces: WorkspaceState[] = [];
  for (const workspace of snapshot.workspaces ?? []) {
    const tabs = tabsByWorkspace.get(workspace.workspace_id);
    if (!tabs) continue;
    workspaces.push({
      id: workspace.workspace_id,
      label: workspace.label ?? "",
      agentStatus: workspace.agent_status ?? "unknown",
      focused: workspace.focused ?? false,
      tabs,
    });
  }

  return {
    focusedWorkspaceId: snapshot.focused_workspace_id ?? null,
    focusedTabId: snapshot.focused_tab_id ?? null,
    focusedPaneId: snapshot.focused_pane_id ?? null,
    workspaces,
  };
}

export type StateStore = {
  get: () => AppState | null;
  refresh: () => Promise<AppState>;
  onChange: (listener: (state: AppState) => void) => () => void;
};

export function createStateStore(options: {
  load: () => Promise<HerdrSnapshot>;
  retryDelayMs?: number;
}): StateStore {
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const listeners = new Set<(state: AppState) => void>();
  let current: AppState | null = null;
  let running: Promise<AppState> | null = null;
  let pending = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRetry = () => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      refresh().catch(() => {
        // 再取得も失敗したら次に要求が来るまで待つ。
      });
    }, retryDelayMs);
  };

  const publish = async (): Promise<AppState> => {
    const state = toAppState(await options.load());
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    current = state;
    for (const listener of listeners) listener(state);
    return state;
  };

  const refresh = (): Promise<AppState> => {
    // 取得中に届いた要求は 1 つに畳み、取得が終わってから 1 回だけ取り直す。
    if (running) {
      pending = true;
      return running;
    }
    pending = false;
    running = (async () => {
      try {
        let latest = await publish();
        while (pending) {
          pending = false;
          latest = await publish();
        }
        return latest;
      } catch (error) {
        // 失敗しても、取得中に届いた要求は捨てずに 1 回だけ取り直す。
        if (pending) {
          pending = false;
          scheduleRetry();
        }
        throw error;
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    get: () => current,
    refresh,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
