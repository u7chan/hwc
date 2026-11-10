import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, HerdrSnapshot } from "./contract";
import type { GitClient } from "../git";
import { type PaneTimesFile, createPaneTimesFile, paneTimesPath } from "./pane-times";
import { type AppState, checkoutPaths, createStateStore, toAppState } from "./state";

const snapshot: HerdrSnapshot = {
  focused_workspace_id: "w1",
  focused_tab_id: "w1:t1",
  focused_pane_id: "w1:p2",
  workspaces: [
    { workspace_id: "w1", label: "hwc", agent_status: "working", focused: true },
    { workspace_id: "w2", label: "other", agent_status: "idle", focused: false },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "main", agent_status: "working", focused: true },
    { tab_id: "w1:t2", workspace_id: "w1", label: "logs", agent_status: "idle", focused: false },
    { tab_id: "w2:t1", workspace_id: "w2", label: "1", agent_status: "idle", focused: false },
  ],
  panes: [
    {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      agent_status: "idle",
      focused: false,
    },
    {
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t1",
      label: "impl-client-api",
      agent_status: "working",
      focused: true,
      agent_session: {
        agent: "pi",
        source: "herdr:pi",
        kind: "path",
        value: "/sessions/--home-dev--/2026-01-01.jsonl",
      },
    },
    {
      pane_id: "w1:p3",
      workspace_id: "w1",
      tab_id: "w1:t2",
      agent_status: "unknown",
      focused: false,
    },
    {
      pane_id: "w2:p1",
      workspace_id: "w2",
      tab_id: "w2:t1",
      agent_status: "idle",
      focused: false,
      agent_session: { agent: "claude", source: "herdr:claude", kind: "path", value: "/tmp/c" },
    },
  ],
  agents: [
    { pane_id: "w1:p2", agent: "pi", terminal_title_stripped: "π - hwc" },
    { pane_id: "w2:p1", agent: "claude", terminal_title_stripped: "claude" },
  ],
};

test("toAppState nests panes under tabs and tabs under workspaces", () => {
  const state = toAppState(snapshot);

  expect(state.workspaces.map((workspace) => workspace.id)).toEqual(["w1", "w2"]);
  expect(state.workspaces[0]?.tabs.map((tab) => tab.id)).toEqual(["w1:t1", "w1:t2"]);
  expect(state.workspaces[0]?.tabs[0]?.panes.map((pane) => pane.id)).toEqual(["w1:p1", "w1:p2"]);
  expect(state.workspaces[1]?.tabs[0]?.panes.map((pane) => pane.id)).toEqual(["w2:p1"]);
});

test("toAppState carries the resolved workspace path", () => {
  const state = toAppState(
    snapshot,
    new Map([
      ["w1", "/repo"],
      ["w2", "/runner"],
    ]),
  );

  expect(state.workspaces.map((workspace) => workspace.path)).toEqual(["/repo", "/runner"]);
});

test("toAppState carries labels, agent names and agent statuses", () => {
  const state = toAppState(snapshot);
  const panes = state.workspaces[0]?.tabs[0]?.panes ?? [];

  expect(state.workspaces[0]).toMatchObject({
    label: "hwc",
    agentStatus: "working",
    focused: true,
  });
  expect(state.workspaces[0]?.tabs[0]).toMatchObject({
    label: "main",
    agentStatus: "working",
    focused: true,
  });
  expect(panes[1]).toEqual({
    id: "w1:p2",
    title: "π - hwc",
    label: "impl-client-api",
    agent: "pi",
    agentStatus: "working",
    focused: true,
    chat: true,
  });
});

test("toAppState keeps the pane label so panes in one tab can be told apart", () => {
  const state = toAppState(snapshot);
  const panes = state.workspaces[0]?.tabs[0]?.panes ?? [];

  // 同じ端末タイトルでも、ラベルがあれば一覧で区別できる。
  expect(panes.map((pane) => pane.label)).toEqual([null, "impl-client-api"]);
  expect(panes[0]?.title).toBeNull();
});

test("toAppState leaves agent fields empty for a pane without an agent", () => {
  const state = toAppState(snapshot);

  expect(state.workspaces[0]?.tabs[0]?.panes[0]).toEqual({
    id: "w1:p1",
    title: null,
    label: null,
    agent: null,
    agentStatus: "idle",
    focused: false,
    chat: false,
  });
  expect(state.workspaces[0]?.tabs[1]?.panes[0]).toMatchObject({
    id: "w1:p3",
    agentStatus: "unknown",
    agent: null,
  });
});

test("toAppState keeps the focused ids for the client", () => {
  expect(toAppState(snapshot)).toMatchObject({
    focusedWorkspaceId: "w1",
    focusedTabId: "w1:t1",
    focusedPaneId: "w1:p2",
  });
});

test("toAppState fills missing focus and collections with empty values", () => {
  expect(toAppState({})).toEqual({
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
    workspaces: [],
  });
});

test("toAppState drops tabs whose workspace is gone and panes whose tab is gone", () => {
  const state = toAppState({
    workspaces: [{ workspace_id: "w1", label: "hwc" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" },
      { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1" },
    ],
    agents: [{ pane_id: "w1:p1", agent: "pi" }],
  });

  expect(state.workspaces).toHaveLength(1);
  expect(state.workspaces[0]?.tabs.map((tab) => tab.id)).toEqual(["w1:t1"]);
  expect(state.workspaces[0]?.tabs[0]?.panes.map((pane) => pane.id)).toEqual(["w1:p1"]);
});

test("toAppState marks chat for pi paths and Codex / OpenCode ids", () => {
  const state = toAppState({
    workspaces: [{ workspace_id: "w1" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
    panes: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: "/a.jsonl" },
      },
      {
        pane_id: "w1:p2",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_session: { agent: "claude", source: "herdr:claude", kind: "path", value: "/b" },
      },
      {
        pane_id: "w1:p3",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_session: { agent: "pi", source: "herdr:pi", kind: "pid", value: "123" },
      },
      {
        pane_id: "w1:p4",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: null },
      },
      {
        pane_id: "w1:p5",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_session: {
          agent: "opencode",
          source: "herdr:opencode",
          kind: "id",
          value: "ses_abc",
        },
      },
      {
        pane_id: "w1:p6",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_session: { agent: "codex", source: "herdr:codex", kind: "id", value: "thread_demo" },
      },
      {
        pane_id: "w1:p7",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_session: { agent: "codex", source: "herdr:codex", kind: "path", value: "/a.jsonl" },
      },
    ],
  });

  expect(state.workspaces[0]?.tabs[0]?.panes.map((pane) => pane.chat)).toEqual([
    true,
    false,
    false,
    false,
    true,
    true,
    false,
  ]);
});

test("the store resolves a chat source by pane id and keeps it out of the state", async () => {
  const { store, loads } = createControlledStore();

  const refresh = store.refresh();
  loads[0]?.resolve(snapshot);
  await refresh;

  expect(store.chatSource("w1:p2")).toEqual({
    agent: "pi",
    path: "/sessions/--home-dev--/2026-01-01.jsonl",
  });
  expect(store.chatSource("w1:p1")).toBeNull();
  // パスはホストの構成を含む。クライアントへ配る状態には載せない。
  expect(JSON.stringify(store.get())).not.toContain("/sessions/");
});

test.each(["codex", "opencode"] as const)(
  "the store resolves a %s session id by pane id",
  async (agent) => {
    const { store, loads } = createControlledStore();

    const refresh = store.refresh();
    loads[0]?.resolve({
      workspaces: [{ workspace_id: "w1" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
      panes: [
        {
          pane_id: "w1:p1",
          workspace_id: "w1",
          tab_id: "w1:t1",
          agent_session: {
            agent,
            source: `herdr:${agent}`,
            kind: "id",
            value: "ses_abc",
          },
        },
      ],
    });
    await refresh;

    expect(store.chatSource("w1:p1")).toEqual({ agent, sessionId: "ses_abc" });
    // セッション id もホスト側の識別子。クライアントへ配る状態には載せない。
    expect(JSON.stringify(store.get())).not.toContain("ses_abc");
  },
);

test("the store drops a chat source once the pane has no session", async () => {
  const { store, loads } = createControlledStore();

  const first = store.refresh();
  loads[0]?.resolve(snapshot);
  await first;

  const second = store.refresh();
  loads[1]?.resolve({
    workspaces: [{ workspace_id: "w1" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
    panes: [{ pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1" }],
  });
  await second;

  expect(store.chatSource("w1:p2")).toBeNull();
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met in time");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createControlledStore() {
  const loads: Array<ReturnType<typeof deferred<HerdrSnapshot>>> = [];
  const store = createStateStore({
    load: () => {
      const load = deferred<HerdrSnapshot>();
      loads.push(load);
      return load.promise;
    },
  });
  return { store, loads };
}

function snapshotWith(workspaceId: string): HerdrSnapshot {
  return {
    focused_workspace_id: workspaceId,
    workspaces: [{ workspace_id: workspaceId }],
    tabs: [{ tab_id: `${workspaceId}:t1`, workspace_id: workspaceId }],
  };
}

const workspaceIds = (state: AppState | null) => state?.workspaces.map((workspace) => workspace.id);

test("refresh publishes the converted state to subscribers", async () => {
  const { store, loads } = createControlledStore();
  const seen: Array<string[] | undefined> = [];
  store.onChange((state) => seen.push(workspaceIds(state)));

  const refresh = store.refresh();
  loads[0]?.resolve(snapshot);
  await refresh;

  expect(workspaceIds(store.get())).toEqual(["w1", "w2"]);
  expect(seen).toEqual([["w1", "w2"]]);
});

test("refresh during a running load coalesces into one extra load", async () => {
  const { store, loads } = createControlledStore();

  const first = store.refresh();
  void store.refresh();
  void store.refresh();
  expect(loads).toHaveLength(1);

  loads[0]?.resolve(snapshotWith("w1"));
  await waitFor(() => loads.length === 2);

  loads[1]?.resolve(snapshotWith("w2"));
  await first;

  expect(loads).toHaveLength(2);
  expect(workspaceIds(store.get())).toEqual(["w2"]);
});

test("events arriving during the trailing load keep the loop going until the state settles", async () => {
  const { store, loads } = createControlledStore();

  const first = store.refresh();
  void store.refresh();
  loads[0]?.resolve(snapshotWith("w1"));
  await waitFor(() => loads.length === 2);

  void store.refresh();
  loads[1]?.resolve(snapshotWith("w2"));
  await waitFor(() => loads.length === 3);

  loads[2]?.resolve(snapshotWith("w3"));
  await first;

  expect(loads).toHaveLength(3);
  expect(workspaceIds(store.get())).toEqual(["w3"]);
});

test("refresh rejects when the load fails and keeps the previous state", async () => {
  const { store, loads } = createControlledStore();

  const first = store.refresh();
  loads[0]?.resolve(snapshotWith("w1"));
  await first;

  const failed = store.refresh();
  loads[1]?.reject(new Error("socket closed"));

  await expect(failed).rejects.toThrow("socket closed");
  expect(workspaceIds(store.get())).toEqual(["w1"]);
});

test("a load failure does not leave the store stuck for the next refresh", async () => {
  const { store, loads } = createControlledStore();

  const failed = store.refresh();
  loads[0]?.reject(new Error("socket closed"));
  await expect(failed).rejects.toThrow("socket closed");

  const retried = store.refresh();
  loads[1]?.resolve(snapshotWith("w1"));
  await retried;

  expect(workspaceIds(store.get())).toEqual(["w1"]);
});

test("a request that arrives while a load fails is retried once", async () => {
  const loads: Array<ReturnType<typeof deferred<HerdrSnapshot>>> = [];
  const store = createStateStore({
    retryDelayMs: 1,
    load: () => {
      const load = deferred<HerdrSnapshot>();
      loads.push(load);
      return load.promise;
    },
  });

  const first = store.refresh();
  void store.refresh();
  loads[0]?.reject(new Error("socket closed"));
  await expect(first).rejects.toThrow("socket closed");

  await waitFor(() => loads.length === 2);
  loads[1]?.resolve(snapshotWith("w9"));

  await waitFor(() => workspaceIds(store.get())?.join() === "w9");
  expect(loads).toHaveLength(2);
});

test("a checkout path falls back to the first pane when herdr sees no worktree", () => {
  const paths = checkoutPaths({
    workspaces: [
      {
        workspace_id: "w1",
        label: "hwc",
        worktree: {
          repo_name: "hwc",
          repo_root: "/repo",
          checkout_path: "/repo",
          is_linked_worktree: false,
        },
      },
      { workspace_id: "w2", label: "runner" },
      { workspace_id: "w3", label: "tmp" },
    ],
    tabs: [],
    panes: [
      { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", cwd: "/runner" },
      { pane_id: "w2:p2", workspace_id: "w2", tab_id: "w2:t1", cwd: "/elsewhere" },
    ],
    agents: [{ pane_id: "w3:p1", workspace_id: "w3", cwd: "/tmp" }],
  } as HerdrSnapshot);

  // ワークツリーの情報があればそれを優先し、1 ペイン目で決める。無いものは載せない。
  expect([...paths].sort()).toEqual([
    ["w1", "/repo"],
    ["w2", "/runner"],
    ["w3", "/tmp"],
  ]);
});

test("the published state carries the path used for git", async () => {
  const store = createStateStore({
    load: async () => ({
      workspaces: [{ workspace_id: "w1", label: "runner" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/runner" }],
    }),
  });

  await store.refresh();

  expect(store.get()?.workspaces[0]?.path).toBe("/runner");
  expect(store.workspacePath("w1")).toBe("/runner");
});

function plainRepoSnapshot(): HerdrSnapshot {
  return {
    workspaces: [{ workspace_id: "w1", label: "pi-lab" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pi-lab" }],
  };
}

function fakeGit(overrides: Partial<GitClient> = {}): GitClient {
  return {
    read: async () => null,
    readRepo: async () => null,
    invalidate: () => {},
    fetch: async () => {},
    pull: async () => {},
    ...overrides,
  };
}

test("a workspace without a herdr worktree gets the git repo facts", async () => {
  const seen: string[] = [];
  const store = createStateStore({
    load: async () => plainRepoSnapshot(),
    git: fakeGit({
      readRepo: async (path) => {
        seen.push(path);
        return { repoName: "pi-lab", repoRoot: "/work/pi-lab", isLinkedWorktree: false };
      },
    }),
  });

  const state = await store.refresh();

  expect(seen).toEqual(["/work/pi-lab"]);
  expect(state.workspaces[0]?.worktree).toEqual({
    repoName: "pi-lab",
    repoRoot: "/work/pi-lab",
    checkoutPath: "/work/pi-lab",
    isLinkedWorktree: false,
    managed: false,
  });
});

test("a herdr worktree is not replaced by git detection", async () => {
  let called = false;
  const store = createStateStore({
    load: async () => repoSnapshot(),
    git: fakeGit({
      readRepo: async () => {
        called = true;
        return { repoName: "other", repoRoot: "/other", isLinkedWorktree: true };
      },
    }),
  });

  const state = await store.refresh();

  expect(called).toBe(false);
  expect(state.workspaces[0]?.worktree).toEqual({
    repoName: "hwc",
    repoRoot: "/repo",
    checkoutPath: "/repo",
    isLinkedWorktree: false,
    managed: true,
  });
});

test("an unreadable repo leaves the workspace without a worktree", async () => {
  const store = createStateStore({
    load: async () => plainRepoSnapshot(),
    git: fakeGit({
      readRepo: async () => {
        throw new Error("not a repository");
      },
    }),
  });

  const state = await store.refresh();

  expect(state.workspaces[0]?.worktree).toBeNull();
});

test("a branch that cannot be read still publishes the state", async () => {
  const store = createStateStore({
    load: async () =>
      ({
        focused_workspace_id: "w1",
        focused_tab_id: "w1:t1",
        focused_pane_id: "w1:p1",
        workspaces: [
          {
            workspace_id: "w1",
            label: "hwc",
            worktree: {
              repo_name: "hwc",
              repo_root: "/repo",
              checkout_path: "/repo",
              is_linked_worktree: false,
            },
          },
        ],
        tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
        panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" }],
        agents: [],
      }) as HerdrSnapshot,
    branch: async () => {
      throw new Error("no git here");
    },
  });

  const state = await store.refresh();
  expect(state.workspaces[0]?.branch).toBeNull();
});

test("a readable branch ends up on the workspace", async () => {
  const store = createStateStore({
    load: async () =>
      ({
        focused_workspace_id: "w1",
        focused_tab_id: "w1:t1",
        focused_pane_id: "w1:p1",
        workspaces: [
          {
            workspace_id: "w1",
            label: "hwc",
            worktree: {
              repo_name: "hwc",
              repo_root: "/repo",
              checkout_path: "/repo",
              is_linked_worktree: false,
            },
          },
        ],
        tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
        panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" }],
        agents: [],
      }) as HerdrSnapshot,
    branch: async () => "feat/row",
  });

  const state = await store.refresh();
  expect(state.workspaces[0]?.branch).toBe("feat/row");
});

function repoSnapshot(): HerdrSnapshot {
  return {
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    workspaces: [
      {
        workspace_id: "w1",
        label: "hwc",
        worktree: {
          repo_name: "hwc",
          repo_root: "/repo",
          checkout_path: "/repo",
          is_linked_worktree: false,
        },
      },
    ],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" }],
    agents: [],
  } as HerdrSnapshot;
}

test("a readable upstream ends up on the workspace", async () => {
  const calls: { checkoutPath: string; branch: string }[] = [];
  const store = createStateStore({
    load: async () => repoSnapshot(),
    branch: async () => "feat/row",
    git: {
      read: async (options) => {
        calls.push(options);
        return {
          upstream: "origin/feat/row",
          ahead: 1,
          behind: 2,
          hasRemote: true,
          repoUrl: "https://github.com/o/r",
        };
      },
      invalidate: () => {},
      readRepo: async () => null,
      fetch: async () => {},
      pull: async () => {},
    },
  });

  const state = await store.refresh();

  expect(state.workspaces[0]?.sync).toEqual({
    upstream: "origin/feat/row",
    ahead: 1,
    behind: 2,
    hasRemote: true,
    repoUrl: "https://github.com/o/r",
  });
  expect(calls).toEqual([{ checkoutPath: "/repo", branch: "feat/row" }]);
});

test("a git failure leaves the sync empty without stopping the state", async () => {
  const store = createStateStore({
    load: async () => repoSnapshot(),
    branch: async () => "feat/row",
    git: {
      read: async () => {
        throw new Error("git is not installed");
      },
      invalidate: () => {},
      readRepo: async () => null,
      fetch: async () => {},
      pull: async () => {},
    },
  });

  const state = await store.refresh();
  expect(state.workspaces[0]?.sync).toBeNull();
});

test("invalidateGit clears the checkout of the workspace", async () => {
  const invalidated: string[] = [];
  const store = createStateStore({
    load: async () => repoSnapshot(),
    branch: async () => "feat/row",
    git: {
      read: async () => null,
      readRepo: async () => null,
      invalidate: (path) => invalidated.push(path),
      fetch: async () => {},
      pull: async () => {},
    },
  });

  await store.refresh();
  store.invalidateGit("w1");

  expect(invalidated).toEqual(["/repo"]);
});

// ペインは w1:p1 から順に振る。状態だけを変えて publish を重ねる。
function paneSnapshot(...list: AgentStatus[]): HerdrSnapshot {
  return {
    workspaces: [{ workspace_id: "w1", label: "hwc" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
    panes: list.map((agent_status, index) => ({
      pane_id: `w1:p${index + 1}`,
      workspace_id: "w1",
      tab_id: "w1:t1",
      agent_status,
    })),
  };
}

function memoryTimes(): PaneTimesFile & { saved: () => string | null } {
  let raw: string | null = null;
  return {
    read: () => raw,
    write: (next) => {
      raw = next;
    },
    saved: () => raw,
  };
}

test("the published state carries the times the store tracked", async () => {
  const store = createStateStore({ load: async () => paneSnapshot("working") });

  const before = Date.now();
  const state = await store.refresh();
  const after = Date.now();

  const since = state.times.workingSince["w1:p1"];
  expect(since).toBeGreaterThanOrEqual(before);
  expect(since).toBeLessThanOrEqual(after);
  expect(state.times.finishedAt).toEqual({});
});

test("a finished pane keeps the time it was first seen done", async () => {
  let status: AgentStatus = "working";
  const store = createStateStore({ load: async () => paneSnapshot(status) });

  await store.refresh();
  status = "done";
  const first = await store.refresh();
  await Bun.sleep(5);
  const later = await store.refresh();

  expect(first.times.finishedAt["w1:p1"]).toBeDefined();
  expect(later.times.finishedAt).toEqual(first.times.finishedAt);
  expect(later.times.workingSince).toEqual({});
});

test("the times are saved and restored by the next store", async () => {
  const root = await mkdtemp(join(tmpdir(), "hwc-times-"));
  try {
    let status: AgentStatus = "working";
    const first = createStateStore({
      load: async () => paneSnapshot(status),
      times: createPaneTimesFile(root),
    });
    const started = (await first.refresh()).times.workingSince["w1:p1"];
    expect(started).toBeDefined();
    expect(await readFile(paneTimesPath(root), "utf8")).toContain('"status":"working"');

    // 再起動相当。同じ状態なら起点を引き継ぐ。
    const restarted = createStateStore({
      load: async () => paneSnapshot(status),
      times: createPaneTimesFile(root),
    });
    expect((await restarted.refresh()).times.workingSince["w1:p1"]).toBe(started);

    // 状態が変わっていれば引き継がない。最初の観測から数え直す。
    status = "done";
    const moved = createStateStore({
      load: async () => paneSnapshot(status),
      times: createPaneTimesFile(root),
    });
    const after = await moved.refresh();
    expect(after.times.workingSince).toEqual({});
    expect(after.times.finishedAt).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a broken times file is dropped instead of stopping the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "hwc-times-"));
  try {
    await writeFile(paneTimesPath(root), "not json");
    const store = createStateStore({
      load: async () => paneSnapshot("working"),
      times: createPaneTimesFile(root),
    });

    const state = await store.refresh();
    expect(state.times.workingSince["w1:p1"]).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the first publish after a failed load records no transition", async () => {
  let fail = false;
  let status: AgentStatus = "working";
  const store = createStateStore({
    load: async () => {
      if (fail) throw new Error("socket closed");
      return paneSnapshot(status);
    },
    times: memoryTimes(),
  });

  await store.refresh();
  fail = true;
  status = "done";
  await expect(store.refresh()).rejects.toThrow("socket closed");

  fail = false;
  // 失敗の間に起きた遷移は観測していない。終了時刻を捏造しない。
  const state = await store.refresh();
  expect(state.times.finishedAt).toEqual({});
  expect(state.times.workingSince).toEqual({});
});

test("a break marked while a load runs still applies to the reload that follows", async () => {
  const { store, loads } = createControlledStore();

  const first = store.refresh();
  loads[0]?.resolve(paneSnapshot("working"));
  await first;
  const started = store.get()?.times.workingSince["w1:p1"];
  expect(started).toBeDefined();

  // 取得中に購読が切れた。合流した再取得まで切れ目が残る。
  const reload = store.refresh();
  store.breakObservation();
  void store.refresh();

  loads[1]?.resolve(paneSnapshot("working", "idle"));
  await waitFor(() => loads.length === 3);
  loads[2]?.resolve(paneSnapshot("done", "done"));
  await reload;

  const times = store.get()?.times;
  // 切れ目の前の観測は残る。
  expect(times?.workingSince).toEqual({});
  expect(times?.finishedAt).toEqual({});
});
