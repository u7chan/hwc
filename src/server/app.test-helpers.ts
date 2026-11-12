import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import type { ChatClient } from "./chat/pi";
import type { ChatSnapshot } from "./chat/contract";
import type { PaneClient } from "./herdr/panes";
import type { WorkspaceClient } from "./herdr/workspaces";
import type { WorktreeClient } from "./herdr/worktrees";
import {
  type AppState,
  type ChatSource,
  type PaneState,
  type StateStore,
  NO_TIMES,
} from "./herdr/state";

export const pane: PaneState = {
  id: "w1:p1",
  title: null,
  label: null,
  agent: null,
  agentStatus: "idle",
  focused: true,
  chat: false,
};

export const state: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  times: NO_TIMES,
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "idle",
      focused: true,
      worktree: null,
      tabs: [
        {
          id: "w1:t1",
          label: "main",
          agentStatus: "idle",
          focused: true,
          panes: [pane],
        },
      ],
    },
  ],
};

export const workingPane: PaneState = { ...pane, agent: "pi", agentStatus: "working", chat: true };

export const threeWorkspaces: AppState = {
  ...state,
  workspaces: ["w1", "w2", "w3"].map((id) => ({
    ...state.workspaces[0]!,
    id,
    label: id,
    focused: id === "w1",
    tabs: [],
  })),
};

export const workingState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      agentStatus: "working",
      tabs: [{ ...state.workspaces[0]!.tabs[0]!, agentStatus: "working", panes: [workingPane] }],
    },
  ],
};

// linked worktree のスペース。チェックアウトの削除はここからだけ受け付ける。
export const worktreeState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      worktree: {
        repoName: "hwc",
        repoRoot: "/project",
        checkoutPath: "/project-worktree",
        isLinkedWorktree: true,
        managed: true,
      },
    },
  ],
};

// リポジトリ本体のスペース。Herdr の worktree.create はここからだけ受け付ける。
export const hostWorktreeState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      worktree: {
        repoName: "hwc",
        repoRoot: "/project",
        checkoutPath: "/project",
        isLinkedWorktree: false,
        managed: true,
      },
    },
  ],
};

// git でリポジトリと分かっただけのスペース。Herdr のワークツリー操作は受け付けない。
export const unmanagedHostState: AppState = {
  ...hostWorktreeState,
  workspaces: [
    {
      ...hostWorktreeState.workspaces[0]!,
      worktree: { ...hostWorktreeState.workspaces[0]!.worktree!, managed: false },
    },
  ],
};

export const unmanagedLinkedState: AppState = {
  ...worktreeState,
  workspaces: [
    {
      ...worktreeState.workspaces[0]!,
      worktree: { ...worktreeState.workspaces[0]!.worktree!, managed: false },
    },
  ],
};

// 同じ場所を指す Herdr ネイティブのスペース。worktree 情報を持たないので、
// リポジトリ束ではなくパスとラベルで重複を見つける。
export const duplicateState: AppState = {
  ...state,
  workspaces: ["w1", "w2"].map((id, index) => ({
    ...state.workspaces[0]!,
    id,
    label: "mypi",
    path: "/work/mypi",
    focused: index === 0,
    tabs: [],
  })),
};

// Herdr がワークツリーとして登録していない git チェックアウトの重複。
// BFF は表示用の worktree 情報を補うが、close はネイティブスペースとして扱う。
export const unmanagedDuplicateState: AppState = {
  ...duplicateState,
  workspaces: duplicateState.workspaces.map((workspace) => ({
    ...workspace,
    worktree: {
      repoName: "mypi",
      repoRoot: "/work",
      checkoutPath: "/work/mypi",
      isLinkedWorktree: false,
      managed: false,
    },
  })),
};

export const chatPane: PaneState = { ...pane, agent: "pi", chat: true };

export const chatState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      tabs: [{ ...state.workspaces[0]!.tabs[0]!, panes: [chatPane] }],
    },
  ],
};

// 添付がペインごとに分かれていることを確かめるため、会話を持つペインを 2 枚持つ状態。
export const twoChatPanesState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      tabs: [
        {
          ...state.workspaces[0]!.tabs[0]!,
          panes: [chatPane, { ...chatPane, id: "w1:p2" }],
        },
      ],
    },
  ],
};

export const checkoutPath = "/work/acme";
export const sessionPath = "/sessions/--home-dev--/2026-01-01.jsonl";
export const otherSessionPath = "/sessions/--home-dev--/2026-01-02.jsonl";

export type FakeStore = StateStore & {
  push: (state: AppState, observed: boolean) => void;
  listenerCount: () => number;
  fireOnSubscribe: (state: AppState) => void;
  setChatSource: (paneId: string, source: ChatSource | null) => void;
  refreshCount: () => number;
};

export function createFakeStore(
  initial: AppState | null,
  failure?: Error,
  workspacePath: string | null = checkoutPath,
): FakeStore {
  const listeners = new Set<(state: AppState, observed: boolean) => void>();
  const sources = new Map<string, ChatSource>();
  let current = initial;
  let pendingOnSubscribe: AppState | null = null;
  let refreshes = 0;

  return {
    get: () => current,
    refresh: async () => {
      refreshes += 1;
      if (failure) throw failure;
      current ??= state;
      return current;
    },
    breakObservation: () => {},
    chatSource: (paneId) => sources.get(paneId) ?? null,
    workspaceRoot: () => null,
    workspacePath: () => workspacePath,
    invalidateGit: () => {},
    onChange: (listener) => {
      listeners.add(listener);
      if (pendingOnSubscribe) {
        const pending = pendingOnSubscribe;
        pendingOnSubscribe = null;
        listener(pending, true);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
    refreshCount: () => refreshes,
    fireOnSubscribe: (state) => {
      pendingOnSubscribe = state;
    },
    setChatSource: (paneId, source) => {
      if (source === null) sources.delete(paneId);
      else sources.set(paneId, source);
    },
    push: (next, observed) => {
      current = next;
      for (const listener of listeners) listener(next, observed);
    },
  };
}

export function createFakeChat(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    snapshot: async () => emptyChat,
    ...overrides,
  };
}

export const emptyChat: ChatSnapshot = {
  etag: "etag-1",
  messages: [],
  model: null,
  effort: null,
  truncated: false,
  context: null,
  compaction: null,
};

export function createFakePanes(overrides: Partial<PaneClient> = {}): PaneClient {
  return {
    read: async ({ paneId }) => ({ paneId, text: "hello\n", truncated: false, revision: 3 }),
    send: async () => {},
    focus: async () => {},
    stop: async () => {},
    interrupt: async () => {},
    process: async () => ({ running: false, command: null, ports: [] }),
    clear: async () => {},
    confirmFolderTrust: async () => {},
    close: async () => {},
    exit: async () => {},
    layout: async ({ paneId }) => ({ cells: [{ paneId, width: 240, height: 48 }] }),
    directory: async () => "/project",
    split: async ({ paneId }) => ({ paneId }),
    startAgent: async () => {},
    rename: async () => {},
    ...overrides,
  };
}

export function createFakeWorktrees(overrides: Partial<WorktreeClient> = {}): WorktreeClient {
  return {
    create: async ({ workspaceId }) => ({ workspaceId, paneId: `${workspaceId}:p1` }),
    remove: async () => {},
    ...overrides,
  };
}

export function createFakeWorkspaces(overrides: Partial<WorkspaceClient> = {}): WorkspaceClient {
  return {
    moveBlock: async () => {},
    close: async () => {},
    ...overrides,
  };
}

// どのテストも同じ BFF を叩く。テストごとに書くのは、そのテストが見たい差分だけにする。
export type TestAppOptions = {
  state?: AppState | null;
  storeFailure?: Error;
  store?: FakeStore;
  panes?: Partial<PaneClient>;
  worktrees?: Partial<WorktreeClient>;
  workspaces?: Partial<WorkspaceClient>;
  chat?: Partial<ChatClient>;
} & Partial<
  Pick<
    Parameters<typeof createApp>[0],
    | "models"
    | "opencode"
    | "codex"
    | "pullRequests"
    | "git"
    | "projects"
    | "revision"
    | "sseHeartbeatMs"
    | "attachmentsRoot"
    | "previewRoots"
    | "notificationSettings"
    | "discordSender"
  >
>;

export function createTestApp(options: TestAppOptions = {}) {
  const {
    state: initial = state,
    storeFailure,
    store,
    panes,
    worktrees,
    workspaces,
    chat,
    ...rest
  } = options;
  const fakeStore = store ?? createFakeStore(initial, storeFailure);
  const app = createApp({
    store: fakeStore,
    panes: createFakePanes(panes),
    worktrees: createFakeWorktrees(worktrees),
    workspaces: createFakeWorkspaces(workspaces),
    chat: createFakeChat(chat),
    ...rest,
  });
  return { app, store: fakeStore };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met in time");
}

export function createSseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  type SseEvent = { event: string | null; data: string };

  return {
    async nextEvent(): Promise<SseEvent> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = raw.split("\n");
          const event =
            lines
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim() ?? null;
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (event || data) return { event, data };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async nextMessage(): Promise<{ state: AppState; now: number }> {
      return JSON.parse((await this.nextEvent()).data) as { state: AppState; now: number };
    },
    // 封筒の外側（now）は各テストの関心ではないので、状態だけを返す。
    async next(): Promise<AppState> {
      return (await this.nextMessage()).state;
    },
    cancel: () => reader.cancel(),
  };
}

export const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// エージェントが書いた画像の配信。根は作業ディレクトリで、添付の保存先とは別に渡す。
export async function withCheckout<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hwc-checkout-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function createFilesApp(
  root: string | null,
  options: { state?: AppState; chat?: Partial<ChatClient>; previewRoots?: string[] } = {},
) {
  const store = createFakeStore(options.state ?? chatState);
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  return createTestApp({
    store: { ...store, workspaceRoot: () => root },
    chat: options.chat,
    previewRoots: options.previewRoots,
  }).app;
}
