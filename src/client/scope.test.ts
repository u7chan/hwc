import { expect, test } from "bun:test";
import type { AgentStatus, AppState, PaneState, WorkspaceState } from "../server/herdr/state";
import {
  activeGroups,
  activePanes,
  countLabel,
  parseListScope,
  pendingReadAfter,
  shouldFocusOnLeave,
  showsTabName,
} from "./scope";

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
  return { focusedWorkspaceId: null, focusedTabId: null, focusedPaneId: null, workspaces };
}

test("the list opens on every space", () => {
  expect(parseListScope(null)).toBe("all");
  expect(parseListScope("all")).toBe("all");
  expect(parseListScope("active")).toBe("active");
  // 消したスコープと知らない値は、既定に倒す。移行処理は持たない。
  expect(parseListScope("agent")).toBe("all");
  expect(parseListScope("everything")).toBe("all");
});

test("active lists the agents that are working, blocked or done", () => {
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

  // エージェントのいないシェルには状態が付かない。idle は一覧に載せない。
  expect(activePanes(state).map((row) => row.pane.id)).toEqual(["w1:p4", "w1:p1", "w1:p5"]);
});

test("active puts what needs attention first and keeps the state order inside a status", () => {
  const state = app(
    workspace(
      "w1",
      [
        pane("w1:p1", "pi", "done"),
        pane("w1:p2", "pi", "working"),
        pane("w1:p3", "pi", "blocked"),
        pane("w1:p4", "pi", "done"),
        pane("w1:p5", "pi", "working"),
      ],
      // 2 タブ目は空。タブをまたいでも state の並びを保つ。
      2,
    ),
    workspace("w2", [pane("w2:p1", "claude", "blocked")]),
  );

  expect(activePanes(state).map((row) => row.pane.id)).toEqual([
    "w1:p3",
    "w2:p1",
    "w1:p2",
    "w1:p5",
    "w1:p1",
    "w1:p4",
  ]);
});

test("active carries the workspace and the tab of each pane", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "working")], 2));

  const [row] = activePanes(state);

  expect(row?.workspace.id).toBe("w1");
  expect(row?.tab.id).toBe("w1:t1");
  expect(row?.pane.id).toBe("w1:p1");
});

test("active keeps no room for the open pane, because idle panes are not in it", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "idle")]));

  // 選択中のペインでも出さない。
  expect(activePanes(state)).toEqual([]);
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

  // 同じスペースの行は 1。done だけのスペースも一覧に出るので 1。idle だけのスペースは帯を作らない。
  expect(activeGroups(state, new Map()).length).toBe(2);
});

test("a space with only its window row counts as a space", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "idle")]));
  const sent = new Map([["w1", { paneId: "w1:p1", at: 1_000 }]]);

  // 窓口は idle でも一覧に残る。帯が出ている以上、件数にも入れる。
  expect(activeGroups(state, sent).length).toBe(1);
});

test("a count past two digits is shown as a range", () => {
  expect(countLabel(0)).toBe("0");
  expect(countLabel(9)).toBe("9");
  expect(countLabel(99)).toBe("99");
  expect(countLabel(100)).toBe("99+");
});

test("a group holds attention, the window, the finished and the running in that order", () => {
  const state = app(
    workspace("w1", [
      pane("w1:p1", "pi", "done"),
      pane("w1:p2", "pi", "working"),
      pane("w1:p3", "pi", "blocked"),
      pane("w1:p4", "claude", "idle"),
    ]),
  );
  const sent = new Map([["w1", { paneId: "w1:p4", at: 1_000 }]]);

  const [group] = activeGroups(state, sent);

  // 要対応が窓口より先。窓口は状態の側から除き、二重に出さない。
  expect(group?.rows.map((row) => row.pane.id)).toEqual(["w1:p3", "w1:p4", "w1:p1", "w1:p2"]);
});

test("groups come in the rank of their top row, then the newest window, then the state order", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi", "working")]),
    workspace("w2", [pane("w2:p1", "pi", "done")]),
    workspace("w3", [pane("w3:p1", "pi", "idle")]),
    workspace("w4", [pane("w4:p1", "pi", "working")]),
    workspace("w5", [pane("w5:p1", "pi", "idle")]),
  );
  const sent = new Map([
    ["w3", { paneId: "w3:p1", at: 1_000 }],
    ["w5", { paneId: "w5:p1", at: 5_000 }],
  ]);

  // 要対応 (0) → 窓口 (1) → 完了 (2) → 実行中 (3)。同じ窓口の順位は新しい順。
  expect(activeGroups(state, sent).map((group) => group.workspace.id)).toEqual([
    "w5",
    "w3",
    "w2",
    "w1",
    "w4",
  ]);
});

test("a group carries the tab of each row and the counts of what it shows", () => {
  const state = app(
    tabsWorkspace("w1", [
      [pane("w1:p1", "pi", "blocked"), pane("w1:p2", "pi", "working")],
      [pane("w1:p3", "pi", "done"), pane("w1:p4", "claude", "idle")],
    ]),
  );
  const sent = new Map([["w1", { paneId: "w1:p4", at: 1_000 }]]);

  const [group] = activeGroups(state, sent);

  expect(group?.rows.map((row) => row.tab.id)).toEqual(["w1:t1", "w1:t2", "w1:t2", "w1:t1"]);
  // 窓口も 1 行として数える。待機の行はどの件数にも入らない。
  expect(group?.counts).toEqual({ blocked: 1, working: 1, done: 1 });
});

test("the tab name is added only when the workspace has more than one tab", () => {
  // 1 タブの既定名「1」は、どの行でも同じなので出さない。
  expect(showsTabName(workspace("w1", [pane("w1:p1", "pi", "working")]))).toBe(false);
  expect(showsTabName(workspace("w1", [pane("w1:p1", "pi", "working")], 2))).toBe(true);
});

test("a window that needs attention moves to the attention side", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "blocked")]));
  const sent = new Map([["w1", { paneId: "w1:p1", at: 1_000 }]]);

  const [group] = activeGroups(state, sent);

  expect(group?.rows.map((row) => row.pane.id)).toEqual(["w1:p1"]);
  expect(group?.rows[0]?.pane.agentStatus).toBe("blocked");
});

test("a finished window stays as one window row", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "done"), pane("w1:p2", "pi", "working")]));
  const sent = new Map([["w1", { paneId: "w1:p1", at: 1_000 }]]);

  const [group] = activeGroups(state, sent);

  // 窓口の done は窓口の側に 1 行だけ残る。状態の側からは除く。
  expect(group?.rows.map((row) => row.pane.id)).toEqual(["w1:p1", "w1:p2"]);
});

test("nothing to read means no groups at all", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "idle"), pane("w1:p2", null, "unknown")]));

  // 窓口がシェルを指していても、状態の行が無ければ空。
  expect(activeGroups(state, new Map())).toEqual([]);
  expect(activeGroups(state, new Map([["w1", { paneId: "w1:p2", at: 1_000 }]]))).toEqual([]);
});
