import { expect, test } from "bun:test";
import {
  type AgentStatus,
  type AppState,
  NO_TIMES,
  type PaneState,
  type WorkspaceState,
} from "../server/herdr/state";
import {
  activeGroups,
  activePanes,
  agentPresence,
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

  // 開いても消えない。起動している限り、待機中も行は残る。
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

test("the group summary tells whether there is an agent", () => {
  expect(agentPresence(1)).toBe("エージェント 1");
  expect(agentPresence(4)).toBe("エージェント 4");
  // 0 は数えず、何が居るかを言う。状態の集約だけではシェルだけの束を見分けられない。
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
    ]),
  );

  const [group] = activeGroups(state);

  // 親 (p1) は待機でも先頭。残りは要対応 → 完了 → 実行中 → 待機 → 不明の順。
  expect(group?.rows.map((row) => row.pane.id)).toEqual([
    "w1:p1",
    "w1:p3",
    "w1:p4",
    "w1:p2",
    "w1:p5",
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

  // 親の定義は ADR 0054 と同じく「左端のタブから最初のエージェント」。
  expect(group?.rows.map((row) => row.pane.id)).toEqual(["w1:p2", "w1:p3"]);
});

test("pinning the parent does not hide the urgency of the group", () => {
  const state = app(
    // 親が待機でも、子の要対応で束は先頭に来る。
    workspace("w1", [pane("w1:p1", "pi", "idle"), pane("w1:p2", "pi", "blocked")]),
    // 親が完了、子が実行中なら、束は完了の順位。
    workspace("w2", [pane("w2:p1", "pi", "done"), pane("w2:p2", "pi", "working")]),
    workspace("w3", [pane("w3:p1", "pi", "working"), pane("w3:p2", "pi", "idle")]),
  );

  // 束の順位は親を含めた最も緊急な行。先頭に固定した親の状態では決めない。
  expect(activeGroups(state).map((group) => group.workspace.id)).toEqual(["w1", "w2", "w3"]);
});

test("groups come in the rank of their most urgent row, then the state order", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi", "working")]),
    workspace("w2", [pane("w2:p1", "pi", "done")]),
    workspace("w3", [pane("w3:p1", "pi", "idle")]),
    workspace("w4", [pane("w4:p1", "pi", "working")]),
    workspace("w5", [pane("w5:p1", "pi", "blocked")]),
  );

  // 要対応 (0) → 完了 (1) → 実行中 (2) → 待機 (3)。同順位は state の並び。
  expect(activeGroups(state).map((group) => group.workspace.id)).toEqual([
    "w5",
    "w2",
    "w1",
    "w4",
    "w3",
  ]);
});

test("a group carries the tab of each row and the counts of what it shows", () => {
  const state = app(
    tabsWorkspace("w1", [
      [pane("w1:p1", "pi", "blocked"), pane("w1:p2", "pi", "working")],
      [pane("w1:p3", "pi", "done"), pane("w1:p4", "claude", "idle")],
    ]),
  );

  const [group] = activeGroups(state);

  expect(group?.rows.map((row) => row.tab.id)).toEqual(["w1:t1", "w1:t2", "w1:t1", "w1:t2"]);
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
