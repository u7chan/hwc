import { expect, test } from "bun:test";
import {
  type AppState,
  createStateStore,
  type HerdrSnapshot,
  parseSnapshot,
  toAppState,
} from "./state";

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
      agent_status: "working",
      focused: true,
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
    agent: "pi",
    agentStatus: "working",
    focused: true,
  });
});

test("toAppState leaves agent fields empty for a pane without an agent", () => {
  const state = toAppState(snapshot);

  expect(state.workspaces[0]?.tabs[0]?.panes[0]).toEqual({
    id: "w1:p1",
    title: null,
    agent: null,
    agentStatus: "idle",
    focused: false,
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

test("parseSnapshot keeps the fields the state needs", () => {
  expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
});

test("parseSnapshot accepts a snapshot without the optional collections", () => {
  expect(parseSnapshot({ focused_workspace_id: "w1" })).toMatchObject({
    focused_workspace_id: "w1",
    focused_tab_id: null,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
  });
});

test("parseSnapshot maps an unknown agent status to unknown", () => {
  const parsed = parseSnapshot({
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "sleeping" }],
  });

  expect(parsed.panes?.[0]?.agent_status).toBe("unknown");
});

test("parseSnapshot rejects a payload that is not a snapshot", () => {
  expect(() => parseSnapshot(null)).toThrow("must be an object");
  expect(() => parseSnapshot([{ workspaces: [] }])).toThrow("must be an object");
  expect(() => parseSnapshot({ workspaces: "w1" })).toThrow("must be an array");
});

test("parseSnapshot rejects a record without its id", () => {
  expect(() => parseSnapshot({ workspaces: [{ label: "hwc" }] })).toThrow("workspace_id");
  expect(() => parseSnapshot({ tabs: [{ tab_id: "w1:t1" }] })).toThrow("tab.workspace_id");
  expect(() => parseSnapshot({ panes: [{ pane_id: "w1:p1", workspace_id: "w1" }] })).toThrow(
    "pane.tab_id",
  );
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
