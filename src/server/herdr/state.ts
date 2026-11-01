export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

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

export type HerdrSnapshot = {
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces?: readonly HerdrWorkspace[];
  tabs?: readonly HerdrTab[];
  panes?: readonly HerdrPane[];
  agents?: readonly HerdrAgent[];
};

type HerdrWorkspace = {
  workspace_id: string;
  label?: string | null;
  agent_status?: AgentStatus;
  focused?: boolean;
};

type HerdrTab = {
  tab_id: string;
  workspace_id: string;
  label?: string | null;
  agent_status?: AgentStatus;
  focused?: boolean;
};

type HerdrPane = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status?: AgentStatus;
  focused?: boolean;
};

type HerdrAgent = {
  pane_id?: string | null;
  agent?: string | null;
  terminal_title_stripped?: string | null;
};

const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`snapshot: ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`snapshot: ${name} must be an array`);
  return value;
}

function expectId(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`snapshot: ${name} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalStatus(value: unknown): AgentStatus {
  return AGENT_STATUSES.includes(value as AgentStatus) ? (value as AgentStatus) : "unknown";
}

function optionalFlag(value: unknown): boolean {
  return value === true;
}

export function parseSnapshot(value: unknown): HerdrSnapshot {
  const raw = expectRecord(value, "snapshot");

  const workspaces = expectArray(raw.workspaces, "workspaces").map((item) => {
    const record = expectRecord(item, "workspace");
    return {
      workspace_id: expectId(record.workspace_id, "workspace_id"),
      label: optionalText(record.label),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
    };
  });

  const tabs = expectArray(raw.tabs, "tabs").map((item) => {
    const record = expectRecord(item, "tab");
    return {
      tab_id: expectId(record.tab_id, "tab_id"),
      workspace_id: expectId(record.workspace_id, "tab.workspace_id"),
      label: optionalText(record.label),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
    };
  });

  const panes = expectArray(raw.panes, "panes").map((item) => {
    const record = expectRecord(item, "pane");
    return {
      pane_id: expectId(record.pane_id, "pane_id"),
      workspace_id: expectId(record.workspace_id, "pane.workspace_id"),
      tab_id: expectId(record.tab_id, "pane.tab_id"),
      agent_status: optionalStatus(record.agent_status),
      focused: optionalFlag(record.focused),
    };
  });

  const agents = expectArray(raw.agents, "agents").map((item) => {
    const record = expectRecord(item, "agent");
    return {
      pane_id: optionalText(record.pane_id),
      agent: optionalText(record.agent),
      terminal_title_stripped: optionalText(record.terminal_title_stripped),
    };
  });

  return {
    focused_workspace_id: optionalText(raw.focused_workspace_id),
    focused_tab_id: optionalText(raw.focused_tab_id),
    focused_pane_id: optionalText(raw.focused_pane_id),
    workspaces,
    tabs,
    panes,
    agents,
  };
}

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
