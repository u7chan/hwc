import type { AgentStatus, HerdrAgent, HerdrAgentSession, HerdrSnapshot } from "./contract";
import { isAbsolute } from "node:path";
import type { BranchReader } from "../git";

export type { AgentStatus };

export type PaneState = {
  id: string;
  title: string | null;
  label: string | null;
  agent: string | null;
  agentStatus: AgentStatus;
  focused: boolean;
  chat: boolean;
};

export type TabState = {
  id: string;
  label: string;
  agentStatus: AgentStatus;
  focused: boolean;
  panes: PaneState[];
};

export type WorktreeState = {
  repoName: string;
  repoRoot: string | null;
  checkoutPath: string | null;
  isLinkedWorktree: boolean;
};

export type WorkspaceState = {
  id: string;
  label: string;
  agentStatus: AgentStatus;
  focused: boolean;
  worktree: WorktreeState | null;
  // ブランチは Herdr の snapshot に無いので、BFF が checkoutPath から読んで足す。
  branch?: string | null;
  tabs: TabState[];
};

export type AppState = {
  focusedWorkspaceId: string | null;
  focusedTabId: string | null;
  focusedPaneId: string | null;
  workspaces: WorkspaceState[];
};

// 会話を読めるのは pi の path セッションだけ。ここでだけ path を取り出し、
// AppState には載せない（クライアントにホストのパスを渡さない）。
function piSessionPath(session: HerdrAgentSession | null | undefined): string | null {
  if (!session || session.agent !== "pi" || session.kind !== "path") return null;
  return session.value === "" ? null : session.value;
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
      label: pane.label ?? null,
      agent: agent?.agent ?? null,
      agentStatus: pane.agent_status ?? "unknown",
      focused: pane.focused ?? false,
      chat: piSessionPath(pane.agent_session) !== null,
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
      worktree: workspace.worktree
        ? {
            repoName: workspace.worktree.repo_name,
            repoRoot: workspace.worktree.repo_root ?? null,
            checkoutPath: workspace.worktree.checkout_path ?? null,
            isLinkedWorktree: workspace.worktree.is_linked_worktree,
          }
        : null,
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
  sessionPath: (paneId: string) => string | null;
};

function toSessionPaths(snapshot: HerdrSnapshot): Map<string, string> {
  const paths = new Map<string, string>();
  for (const pane of snapshot.panes ?? []) {
    const path = piSessionPath(pane.agent_session);
    if (path !== null) paths.set(pane.pane_id, path);
  }
  return paths;
}

// ブランチを読む場所。Herdr がワークツリーとして扱っていないディレクトリでも git の
// 管理下にあることはあるので、無ければ最初のペインの cwd を使う。
export function checkoutPaths(snapshot: HerdrSnapshot): Map<string, string> {
  const paths = new Map<string, string>();
  for (const workspace of snapshot.workspaces ?? []) {
    const path = workspace.worktree?.checkout_path ?? null;
    if (path !== null) paths.set(workspace.workspace_id, path);
  }
  for (const pane of snapshot.panes ?? []) {
    if (paths.has(pane.workspace_id) || typeof pane.cwd !== "string") continue;
    // 相対の cwd は BFF の起動ディレクトリを指してしまうので使わない。
    if (!isAbsolute(pane.cwd)) continue;
    paths.set(pane.workspace_id, pane.cwd);
  }
  for (const agent of snapshot.agents ?? []) {
    const workspaceId = agent.workspace_id;
    if (workspaceId == null || paths.has(workspaceId) || agent.cwd == null) continue;
    if (!isAbsolute(agent.cwd)) continue;
    paths.set(workspaceId, agent.cwd);
  }
  return paths;
}

// ブランチは Herdr が返さないので、ワークツリーの置き場所から読んで足す。
// 読めなくても状態そのものは流す（ブランチが出ないだけ）。
async function withBranches(
  state: AppState,
  read: BranchReader | undefined,
  paths: Map<string, string>,
): Promise<AppState> {
  if (read === undefined) return state;
  const workspaces = await Promise.all(
    state.workspaces.map(async (workspace) => {
      const path = paths.get(workspace.id);
      if (path === undefined) return workspace;
      // 読めないブランチで状態そのものを止めない。
      const branch = await read(path).catch(() => null);
      return { ...workspace, branch };
    }),
  );
  return { ...state, workspaces };
}

export function createStateStore(options: {
  load: () => Promise<HerdrSnapshot>;
  retryDelayMs?: number;
  branch?: BranchReader;
}): StateStore {
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const listeners = new Set<(state: AppState) => void>();
  let current: AppState | null = null;
  let sessions = new Map<string, string>();
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
    const snapshot = await options.load();
    const state = await withBranches(toAppState(snapshot), options.branch, checkoutPaths(snapshot));
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    current = state;
    sessions = toSessionPaths(snapshot);
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
    sessionPath: (paneId) => sessions.get(paneId) ?? null,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
