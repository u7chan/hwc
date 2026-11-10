import { expect, test } from "bun:test";
import { createExitCleanup } from "./exit-cleanup";
import { type AppState, NO_TIMES, type PaneState, type StateStore } from "./herdr/state";

function pane(agent: string | null): PaneState {
  return {
    id: "w1:p1",
    title: null,
    label: null,
    agent,
    agentStatus: agent === null ? "unknown" : "idle",
    focused: true,
    chat: agent !== null,
  };
}

function stateWith(agent: string | null): AppState {
  return {
    focusedWorkspaceId: "w1",
    focusedTabId: "w1:t1",
    focusedPaneId: "w1:p1",
    times: NO_TIMES,
    workspaces: [
      {
        id: "w1",
        label: "hwc",
        agentStatus: agent === null ? "unknown" : "idle",
        focused: true,
        worktree: null,
        tabs: [
          {
            id: "w1:t1",
            label: "main",
            agentStatus: agent === null ? "unknown" : "idle",
            focused: true,
            panes: [pane(agent)],
          },
        ],
      },
    ],
  };
}

const empty: AppState = {
  focusedWorkspaceId: null,
  focusedTabId: null,
  focusedPaneId: null,
  times: NO_TIMES,
  workspaces: [],
};

function createFakeStore(initial: AppState) {
  const listeners = new Set<(state: AppState) => void>();
  let current = initial;
  const store: Pick<StateStore, "get" | "onChange"> & {
    push: (next: AppState) => void;
    listening: () => number;
  } = {
    get: () => current,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push: (next) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
    listening: () => listeners.size,
  };
  return store;
}

function createFakePanes() {
  const clearCalls: string[] = [];
  const clear = async ({ paneId }: { paneId: string }) => {
    clearCalls.push(paneId);
  };
  return { panes: { clear }, clearCalls };
}

// 短い上限で、テストの間にタイマーを残さない。
const SHORT_TIMEOUT_MS = 20;

test("clears the old agent screen once the pane is a shell", () => {
  const store = createFakeStore(stateWith("opencode"));
  const { panes, clearCalls } = createFakePanes();
  const exitCleanup = createExitCleanup(store, panes);

  exitCleanup("w1:p1");
  store.push(stateWith(null));

  expect(clearCalls).toEqual(["w1:p1"]);
  // 消した後は購読も外す。状態が届くたびに同じペインを消さない。
  expect(store.listening()).toBe(0);
  store.push(stateWith(null));
  expect(clearCalls).toEqual(["w1:p1"]);
});

test("waits while the agent is still running", () => {
  const store = createFakeStore(stateWith("opencode"));
  const { panes, clearCalls } = createFakePanes();
  const exitCleanup = createExitCleanup(store, panes, SHORT_TIMEOUT_MS);

  exitCleanup("w1:p1");
  store.push(stateWith("opencode"));

  expect(clearCalls).toEqual([]);
  expect(store.listening()).toBe(1);
  // 上限を過ぎたら待つのをやめる。あとから終了しても、別の会話の画面を消さない。
  return Bun.sleep(SHORT_TIMEOUT_MS * 2).then(() => {
    expect(store.listening()).toBe(0);
    store.push(stateWith(null));
    expect(clearCalls).toEqual([]);
  });
});

test("clears immediately when the exit is already visible", () => {
  const store = createFakeStore(stateWith(null));
  const { panes, clearCalls } = createFakePanes();

  createExitCleanup(store, panes)("w1:p1");

  expect(clearCalls).toEqual(["w1:p1"]);
});

test("does not clear a pane that is gone or was replaced by another agent", () => {
  const gone = createFakeStore(stateWith("opencode"));
  const first = createFakePanes();
  const cleanupGone = createExitCleanup(gone, first.panes);
  cleanupGone("w1:p1");
  gone.push(empty);
  expect(first.clearCalls).toEqual([]);
  expect(gone.listening()).toBe(0);

  const replaced = createFakeStore(stateWith("opencode"));
  const second = createFakePanes();
  const cleanupReplaced = createExitCleanup(replaced, second.panes);
  cleanupReplaced("w1:p1");
  replaced.push(stateWith("codex"));
  expect(second.clearCalls).toEqual([]);
  expect(replaced.listening()).toBe(0);
});

test("ignores panes that are not in the state", () => {
  const store = createFakeStore(stateWith("opencode"));
  const { panes, clearCalls } = createFakePanes();

  createExitCleanup(store, panes)("w1:p9");

  expect(clearCalls).toEqual([]);
  expect(store.listening()).toBe(0);
});

test("does not repeat a pending exit request", () => {
  const store = createFakeStore(stateWith("opencode"));
  const { panes, clearCalls } = createFakePanes();
  const exitCleanup = createExitCleanup(store, panes);

  exitCleanup("w1:p1");
  exitCleanup("w1:p1");
  expect(store.listening()).toBe(1);

  store.push(stateWith(null));
  expect(clearCalls).toEqual(["w1:p1"]);
});

test("ignores a failed clear", async () => {
  const store = createFakeStore(stateWith("opencode"));
  const clear = async () => {
    throw new Error("socket closed");
  };

  createExitCleanup(store, { clear })("w1:p1");
  store.push(stateWith(null));
  await Bun.sleep(0);

  expect(store.listening()).toBe(0);
});
