import { expect, test } from "bun:test";
import {
  type AgentStatus,
  type AppState,
  NO_TIMES,
  type PaneState,
  type WorkspaceState,
} from "../server/herdr/state";
import {
  LIST_SCOPE_STORAGE_KEY,
  activeGroups,
  activePanes,
  agentPresence,
  countLabel,
  loadListScope,
  parseListScope,
  pendingReadAfter,
  saveListScope,
  shouldFocusOnLeave,
  showsTabName,
} from "./scope";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function deniedStorage() {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
}

function pane(id: string, agent: string | null, agentStatus: AgentStatus = "unknown"): PaneState {
  return {
    id,
    title: null,
    label: null,
    agent,
    agentStatus,
    focused: false,
    chat: false,
  };
}

function workspace(id: string, panes: readonly PaneState[], tabs = 1): WorkspaceState {
  return tabsWorkspace(
    id,
    Array.from({ length: tabs }, (_, index) => (index === 0 ? panes : [])),
  );
}

// タブごとにペインを置く。タブ表示や束の中の並びはタブをまたぐ。
function tabsWorkspace(id: string, tabPanes: readonly (readonly PaneState[])[]): WorkspaceState {
  return {
    id,
    label: id,
    agentStatus: "unknown",
    focused: false,
    worktree: null,
    tabs: tabPanes.map((panes, index) => ({
      id: `${id}:t${index + 1}`,
      label: String(index + 1),
      agentStatus: "unknown" as const,
      focused: false,
      panes: [...panes],
    })),
  };
}

function app(...workspaces: WorkspaceState[]): AppState {
  return {
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
    times: NO_TIMES,
    workspaces,
  };
}

test("the list opens on every space", () => {
  expect(parseListScope(null)).toBe("all");
  expect(parseListScope("all")).toBe("all");
  expect(parseListScope("active")).toBe("active");
  // 消したスコープと知らない値は、既定に倒す。移行処理は持たない。
  expect(parseListScope("agent")).toBe("all");
  expect(parseListScope("everything")).toBe("all");
});

test("the list scope keeps the storage key its setting is read from", () => {
  expect(LIST_SCOPE_STORAGE_KEY).toBe("hwc-list-scope");
});

test("the chosen scope is stored as the value itself and comes back", () => {
  const store = memoryStorage();
  saveListScope(store, "active");

  expect(store.map.get(LIST_SCOPE_STORAGE_KEY)).toBe("active");
  expect(loadListScope(store)).toBe("active");
});

test("an unreadable scope falls back to every space", () => {
  expect(loadListScope(memoryStorage())).toBe("all");
  expect(loadListScope(memoryStorage({ [LIST_SCOPE_STORAGE_KEY]: "agent" }))).toBe("all");
  expect(loadListScope(deniedStorage())).toBe("all");
  expect(loadListScope(null)).toBe("all");
  expect(() => saveListScope(deniedStorage(), "active")).not.toThrow();
  expect(() => saveListScope(null, "active")).not.toThrow();
});

test("active lists every pane that has an agent, whatever its status", () => {
  const state = app(
    workspace("w1", [
      pane("w1:p1", "pi", "working"),
      pane("w1:p2", null, "unknown"),
      pane("w1:p3", "claude", "idle"),
      pane("w1:p4", "pi", "blocked"),
      pane("w1:p5", "codex", "done"),
      pane("w1:p6", null, "done"),
    ]),
  );

  // エージェントのいないシェルだけを外す。待機中も、起動していれば並べる。
  expect(activePanes(state).map((row) => row.pane.id)).toEqual([
    "w1:p1",
    "w1:p3",
    "w1:p4",
    "w1:p5",
  ]);
});

test("active keeps the state order, because the group decides how to show it", () => {
  const state = app(
    workspace(
      "w1",
      [
        pane("w1:p1", "pi", "done"),
        pane("w1:p2", "pi", "working"),
        pane("w1:p3", "pi", "blocked"),
        pane("w1:p4", "pi", "idle"),
      ],
      // 2 タブ目は空。タブをまたいでも state の並びを保つ。
      2,
    ),
    workspace("w2", [pane("w2:p1", "claude", "blocked")]),
  );

  expect(activePanes(state).map((row) => row.pane.id)).toEqual([
    "w1:p1",
    "w1:p2",
    "w1:p3",
    "w1:p4",
    "w2:p1",
  ]);
});

test("active carries the workspace and the tab of each pane", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "working")], 2));

  const [row] = activePanes(state);

  expect(row?.workspace.id).toBe("w1");
  expect(row?.tab.id).toBe("w1:t1");
  expect(row?.pane.id).toBe("w1:p1");
});

test("a waiting agent stays in the list", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "idle")]));

  expect(activePanes(state).map((row) => row.pane.id)).toEqual(["w1:p1"]);
});

test("only a done pane that is left after it finishes moves the focus", () => {
  // 離れる時点で done なら送る。開いた時点の状態は問わない。
  expect(shouldFocusOnLeave("w1:p1", "w1:p2", "done")).toBe(true);
  expect(shouldFocusOnLeave("w1:p1", null, "done")).toBe(true);
  // 同じ行をもう一度押しただけでは離れていない。
  expect(shouldFocusOnLeave("w1:p1", "w1:p1", "done")).toBe(false);
  // 離れる時点で done でなければ seen は進めない。
  expect(shouldFocusOnLeave("w1:p1", "w1:p2", "working")).toBe(false);
  expect(shouldFocusOnLeave("w1:p1", "w1:p2", "blocked")).toBe(false);
  expect(shouldFocusOnLeave("w1:p1", "w1:p2", "idle")).toBe(false);
  // ペインが消えた場合は送らない（保留を捨てる）。
  expect(shouldFocusOnLeave("w1:p1", "w1:p2", null)).toBe(false);
  // 保留を作るのはアクティブ一覧の行だけ。ツリー・タブバー・復元では null のまま。
  expect(shouldFocusOnLeave(null, "w1:p1", "done")).toBe(false);
  expect(shouldFocusOnLeave(null, null, "done")).toBe(false);
});

test("the pending read survives a move that does not leave the pane", () => {
  // アクティブ一覧で開いた行は、その場で保留になる。
  expect(pendingReadAfter(null, "w1:p1", true)).toBe("w1:p1");
  expect(pendingReadAfter("w1:p1", "w1:p2", true)).toBe("w1:p2");
  // 詳細のタブバーやツリーで同じペインを選び直しても、まだ離れていない。
  expect(pendingReadAfter("w1:p1", "w1:p1", false)).toBe("w1:p1");
  // 別のペインへ移る（詳細から戻る）と離れるので捨てる。
  expect(pendingReadAfter("w1:p1", "w1:p2", false)).toBeNull();
  expect(pendingReadAfter("w1:p1", null, false)).toBeNull();
  // 保留が無いまま同じペインへ移っても、保留は作らない。
  expect(pendingReadAfter(null, "w1:p1", false)).toBeNull();
});

test("the count is the spaces in the active list, not the rows", () => {
  const state = app(
    workspace("w1", [
      pane("w1:p1", "pi", "working"),
      pane("w1:p2", "pi", "blocked"),
      pane("w1:p3", "pi", "done"),
      pane("w1:p4", "claude", "done"),
      pane("w1:p5", "pi", "idle"),
      pane("w1:p6", null, "done"),
    ]),
    workspace("w2", [pane("w2:p1", "pi", "done")]),
    workspace("w3", [pane("w3:p1", "pi", "idle")]),
  );

  // 同じスペースの行は 1。完了だけのスペースも、待機だけのスペースも帯を作るので 1。
  expect(activeGroups(state).length).toBe(3);
});

test("a count past two digits is shown as a range", () => {
  expect(countLabel(0)).toBe("0");
  expect(countLabel(9)).toBe("9");
  expect(countLabel(99)).toBe("99");
  expect(countLabel(100)).toBe("99+");
});

test("the agent badge and the shell mark name what the group holds", () => {
  expect(agentPresence(1)).toBe("エージェント 1");
  expect(agentPresence(4)).toBe("エージェント 4");
  // 0 は数えず、何が居るかを言う。束の副題は件数に任せ、シェル記号の名前はここから取る。
  expect(agentPresence(0)).toBe("シェルのみ");
});

test("the parent stays at the top and the rest follow the state order", () => {
  const state = app(
    workspace("w1", [
      pane("w1:p1", "pi", "idle"),
      pane("w1:p2", "pi", "working"),
      pane("w1:p3", "pi", "blocked"),
      pane("w1:p4", "claude", "done"),
      pane("w1:p5", "pi", "unknown"),
      pane("w1:p6", "claude", "idle"),
    ]),
  );

  const [group] = activeGroups(state);

  // 親 (p1) だけ先頭へ移す。残りは状態で並べ替えず、state の順のまま。
  expect(group?.rows.map((row) => row.pane.id)).toEqual([
    "w1:p1",
    "w1:p2",
    "w1:p3",
    "w1:p4",
    "w1:p5",
    "w1:p6",
  ]);
});

test("the parent skips a shell, so the first agent leads the group", () => {
  const state = app(
    workspace("w1", [
      pane("w1:p1", null),
      pane("w1:p2", "pi", "idle"),
      pane("w1:p3", "pi", "blocked"),
    ]),
  );

  const [group] = activeGroups(state);

  // 親の定義はファビコンと同じく「左端のタブから最初のエージェント」。
  expect(group?.rows.map((row) => row.pane.id)).toEqual(["w1:p2", "w1:p3"]);
});

test("a group keeps its place when the statuses change or a done row is read", () => {
  const before = app(
    workspace("w1", [pane("w1:p1", "pi", "idle")]),
    workspace("w2", [pane("w2:p1", "pi", "blocked")]),
    workspace("w3", [pane("w3:p1", "pi", "done")]),
  );
  const after = app(
    // 要対応は実行中へ、完了は既読で待機へ、待機は完了へ。
    workspace("w1", [pane("w1:p1", "pi", "done")]),
    workspace("w2", [pane("w2:p1", "pi", "working")]),
    workspace("w3", [pane("w3:p1", "pi", "idle")]),
  );

  // 束の順は state の並び。状態が変わっても入れ替えない。
  expect(activeGroups(before).map((group) => group.workspace.id)).toEqual(["w1", "w2", "w3"]);
  expect(activeGroups(after).map((group) => group.workspace.id)).toEqual(["w1", "w2", "w3"]);
});

test("a group carries the tab of each row and the counts of what it shows", () => {
  const state = app(
    tabsWorkspace("w1", [
      [pane("w1:p1", "pi", "blocked"), pane("w1:p2", "pi", "working")],
      [pane("w1:p3", "pi", "done"), pane("w1:p4", "claude", "idle")],
    ]),
  );

  const [group] = activeGroups(state);

  // 行はタブをまたいでも state の順。状態では並べ替えない。
  expect(group?.rows.map((row) => row.tab.id)).toEqual(["w1:t1", "w1:t1", "w1:t2", "w1:t2"]);
  // 待機の行は並ぶが、どの件数にも入らない。
  expect(group?.counts).toEqual({ blocked: 1, working: 1, done: 1 });
});

test("the tab name is added only when the workspace has more than one tab", () => {
  // 1 タブの既定名「1」は、どの行でも同じなので出さない。
  expect(showsTabName(workspace("w1", [pane("w1:p1", "pi", "working")]))).toBe(false);
  expect(showsTabName(workspace("w1", [pane("w1:p1", "pi", "working")], 2))).toBe(true);
});

test("a space with only shells makes no group", () => {
  const state = app(workspace("w1", [pane("w1:p1", null, "unknown"), pane("w1:p2", null, "idle")]));

  // シェルだけのスペースは「すべて」で見る。
  expect(activeGroups(state)).toEqual([]);
});
