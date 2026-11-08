import type { AgentStatus, HerdrAgent, HerdrAgentSession, HerdrSnapshot } from "./contract";
import { isAbsolute } from "node:path";
import type { BranchReader, GitClient } from "../git";
import type { GitSync } from "../../shared/git";

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
  // 上流ブランチとの差。リモートが無い・読めない場合は null。
  sync?: GitSync | null;
  tabs: TabState[];
};

export type AppState = {
  focusedWorkspaceId: string | null;
  focusedTabId: string | null;
  focusedPaneId: string | null;
  workspaces: WorkspaceState[];
};

// セッションの在り処は AppState に載せず、BFF 内だけで解決する。
export type ChatSource =
  | { agent: "pi"; path: string }
  | { agent: "codex" | "opencode"; sessionId: string };

function chatSourceOf(session: HerdrAgentSession | null | undefined): ChatSource | null {
  if (!session) return null;
  const value = session.value;
  if (value === null || value === "") return null;
  if (session.agent === "pi" && session.kind === "path") {
    return { agent: "pi", path: value };
  }
  if ((session.agent === "codex" || session.agent === "opencode") && session.kind === "id") {
    return { agent: session.agent, sessionId: value };
  }
  return null;
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
      chat: chatSourceOf(pane.agent_session) !== null,
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
  chatSource: (paneId: string) => ChatSource | null;
  // ペインが作業しているチェックアウト。画像の配信元を決めるのに使う。
  workspaceRoot: (paneId: string) => string | null;
  // スペースのチェックアウト。ブランチと同じ場所を、PR の問い合わせ先にも使う。
  workspacePath: (workspaceId: string) => string | null;
  // fetch / pull の後、次に状態を公開するときに読み直す。
  invalidateGit: (workspaceId: string) => void;
};

function toChatSources(snapshot: HerdrSnapshot): Map<string, ChatSource> {
  const sources = new Map<string, ChatSource>();
  for (const pane of snapshot.panes ?? []) {
    const source = chatSourceOf(pane.agent_session);
    if (source !== null) sources.set(pane.pane_id, source);
  }
  return sources;
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

// チェックアウトの在り処はワークスペース単位で決まる。ペインから引けるように引き直す。
function toPaneRoots(snapshot: HerdrSnapshot, roots: Map<string, string>): Map<string, string> {
  const paneRoots = new Map<string, string>();
  for (const pane of snapshot.panes ?? []) {
    const root = roots.get(pane.workspace_id);
    if (root !== undefined) paneRoots.set(pane.pane_id, root);
  }
  return paneRoots;
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

// 上流ブランチとの差は、ブランチが読めたスペースだけに足す。git の失敗で状態を止めない。
async function withSync(
  state: AppState,
  read: GitClient | undefined,
  paths: Map<string, string>,
): Promise<AppState> {
  if (read === undefined) return state;
  const workspaces = await Promise.all(
    state.workspaces.map(async (workspace) => {
      const path = paths.get(workspace.id);
      const branch = workspace.branch ?? null;
      if (path === undefined || branch === null) return { ...workspace, sync: null };
      const sync = await read.read({ checkoutPath: path, branch }).catch(() => null);
      return { ...workspace, sync };
    }),
  );
  return { ...state, workspaces };
}

export function createStateStore(options: {
  load: () => Promise<HerdrSnapshot>;
  retryDelayMs?: number;
  branch?: BranchReader;
  git?: GitClient;
}): StateStore {
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const listeners = new Set<(state: AppState) => void>();
  let current: AppState | null = null;
  let sources = new Map<string, ChatSource>();
  let workspacePaths = new Map<string, string>();
  let paneRoots = new Map<string, string>();
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
    const roots = checkoutPaths(snapshot);
    const branched = await withBranches(toAppState(snapshot), options.branch, roots);
    const state = await withSync(branched, options.git, roots);
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    current = state;
    sources = toChatSources(snapshot);
    workspacePaths = roots;
    paneRoots = toPaneRoots(snapshot, roots);
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
    chatSource: (paneId) => sources.get(paneId) ?? null,
    workspaceRoot: (paneId) => paneRoots.get(paneId) ?? null,
    workspacePath: (workspaceId) => workspacePaths.get(workspaceId) ?? null,
    invalidateGit: (workspaceId) => {
      const path = workspacePaths.get(workspaceId);
      if (path !== undefined) options.git?.invalidate(path);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
