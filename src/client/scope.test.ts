import { expect, test } from "bun:test";
import type { AgentStatus, AppState, PaneState, WorkspaceState } from "../server/herdr/state";
import {
  activePanes,
  activeUnreadCount,
  activeViewRows,
  parseListScope,
  scopeWorkspaces,
  shouldFocusPane,
  unreadLabel,
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
  return {
    id,
    label: id,
    agentStatus: "unknown",
    focused: false,
    worktree: null,
    tabs: Array.from({ length: tabs }, (_, index) => ({
      id: `${id}:t${index + 1}`,
      label: String(index + 1),
      agentStatus: "unknown" as const,
      focused: false,
      // 1 タブ目にだけペインを置き、2 タブ目以降は空にする。
      panes: index === 0 ? [...panes] : [],
    })),
  };
}

function app(...workspaces: WorkspaceState[]): AppState {
  return { focusedWorkspaceId: null, focusedTabId: null, focusedPaneId: null, workspaces };
}

function agents(workspaceId: string, list: readonly (string | null)[]): PaneState[] {
  return list.map((agent, index) => pane(`${workspaceId}:p${index + 1}`, agent));
}

test("the list starts with the spaces that have an agent", () => {
  expect(parseListScope(null)).toBe("agent");
  expect(parseListScope("agent")).toBe("agent");
  expect(parseListScope("active")).toBe("active");
  expect(parseListScope("all")).toBe("all");
  // 端末に残った知らない値では、既定に倒す。
  expect(parseListScope("everything")).toBe("agent");
});

test("agent scope keeps the spaces that have an agent and drops shell-only spaces", () => {
  const spaces = [workspace("w1", agents("w1", [null])), workspace("w2", agents("w2", ["pi"]))];

  expect(scopeWorkspaces(spaces, "agent").map((space) => space.id)).toEqual(["w2"]);
  expect(scopeWorkspaces(spaces, "all").map((space) => space.id)).toEqual(["w1", "w2"]);
});

test("agent scope updates when the last agent in a space exits", () => {
  const withAgent = [workspace("w1", agents("w1", ["pi"]))];
  const shellOnly = [workspace("w1", agents("w1", [null]))];

  expect(scopeWorkspaces(withAgent, "agent").map((space) => space.id)).toEqual(["w1"]);
  expect(scopeWorkspaces(shellOnly, "agent")).toEqual([]);
  expect(scopeWorkspaces(shellOnly, "all").map((space) => space.id)).toEqual(["w1"]);
});

test("the order stays the order Herdr reports", () => {
  const spaces = [
    workspace("w3", agents("w3", ["pi"])),
    workspace("w1", agents("w1", ["claude"])),
    workspace("w2", agents("w2", [null])),
  ];

  expect(scopeWorkspaces(spaces, "agent").map((space) => space.id)).toEqual(["w3", "w1"]);
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

test("only a done row in the active scope moves the focus", () => {
  expect(shouldFocusPane("active", "done")).toBe(true);
  expect(shouldFocusPane("active", "working")).toBe(false);
  expect(shouldFocusPane("active", "blocked")).toBe(false);
  // ツリーからは送らない。詳細のタブ切替と経路が同じになる。
  expect(shouldFocusPane("agent", "done")).toBe(false);
  expect(shouldFocusPane("all", "done")).toBe(false);
});

test("the unread count is the finished panes waiting to be seen", () => {
  const state = app(
    workspace("w1", [
      pane("w1:p1", "pi", "working"),
      pane("w1:p2", "pi", "blocked"),
      pane("w1:p3", "pi", "done"),
      pane("w1:p4", "claude", "done"),
      pane("w1:p5", "pi", "idle"),
      pane("w1:p6", null, "done"),
    ]),
  );

  // blocked は未読ではない。エージェントのいない done は active に載らない。
  expect(activeUnreadCount(state)).toBe(2);
});

test("nothing unfinished means nothing unread", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi", "working"), pane("w1:p2", "pi", "blocked")]),
  );

  expect(activeUnreadCount(state)).toBe(0);
});

test("a count past two digits is shown as a range", () => {
  expect(unreadLabel(0)).toBe("0");
  expect(unreadLabel(9)).toBe("9");
  expect(unreadLabel(99)).toBe("99");
  expect(unreadLabel(100)).toBe("99+");
});

test("the view lists what needs attention, the windows, the finished and the running", () => {
  const state = app(
    workspace("w1", [
      pane("w1:p1", "pi", "done"),
      pane("w1:p2", "pi", "working"),
      pane("w1:p3", "pi", "blocked"),
      pane("w1:p4", "claude", "idle"),
      pane("w1:p5", "codex", "done"),
    ]),
    workspace("w2", [pane("w2:p1", "pi", "idle")]),
  );
  const sent = new Map([
    ["w2", { paneId: "w2:p1", at: 3_000 }],
    ["w1", { paneId: "w1:p4", at: 1_000 }],
  ]);

  expect(activeViewRows(state, sent).map((row) => row.pane.id)).toEqual([
    "w1:p3",
    "w2:p1",
    "w1:p4",
    "w1:p1",
    "w1:p5",
    "w1:p2",
  ]);
});

test("a window row is not repeated in the status rows", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "done"), pane("w1:p2", "pi", "working")]));
  const sent = new Map([["w1", { paneId: "w1:p1", at: 1_000 }]]);

  // done と working は状態の行にもある。窓口に置いたものを先にし、重ねて出さない。
  expect(activeViewRows(state, sent).map((row) => row.pane.id)).toEqual(["w1:p1", "w1:p2"]);
});

test("a window that needs attention moves to the attention side", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "blocked")]));
  const sent = new Map([["w1", { paneId: "w1:p1", at: 1_000 }]]);

  const rows = activeViewRows(state, sent);

  expect(rows.map((row) => row.pane.id)).toEqual(["w1:p1"]);
  expect(rows[0]?.pane.agentStatus).toBe("blocked");
});

test("nothing to read means no rows at all", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "idle"), pane("w1:p2", null, "unknown")]));

  // 窓口がシェルを指していても、状態の行が無ければ空。
  expect(activeViewRows(state, new Map())).toEqual([]);
  expect(activeViewRows(state, new Map([["w1", { paneId: "w1:p2", at: 1_000 }]]))).toEqual([]);
});
