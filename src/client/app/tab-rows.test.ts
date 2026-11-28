import { expect, test } from "bun:test";
import { type AppState, NO_TIMES, type PaneState, type TabState } from "../../server/herdr/state";
import { tabRows } from "./tab-rows";

const pane = (id: string): PaneState => ({
  id,
  title: null,
  label: null,
  agent: null,
  agentStatus: "idle",
  focused: false,
  chat: false,
});

const tab = (id: string, paneIds: string[]): TabState => ({
  id,
  label: id,
  agentStatus: "idle",
  focused: false,
  panes: paneIds.map(pane),
});

const state = (workspaces: { id: string; paneIds: string[] }[]): AppState => ({
  focusedWorkspaceId: workspaces[0]?.id ?? null,
  focusedTabId: null,
  focusedPaneId: null,
  activeOrder: [],
  times: NO_TIMES,
  workspaces: workspaces.map((workspace) => ({
    id: workspace.id,
    label: workspace.id,
    agentStatus: "idle",
    focused: false,
    worktree: null,
    path: `/home/example/${workspace.id}`,
    branch: null,
    sync: null,
    tabs: [tab(`${workspace.id}:t1`, workspace.paneIds)],
  })),
});

const twoSpaces = state([
  { id: "w1", paneIds: ["w1:p1", "w1:p2"] },
  { id: "w2", paneIds: ["w2:p1"] },
]);

// 並びは葉の tabs が正。表示に要る workspace / tab / pane をその順で引く。
test("the rows follow the tab order of the leaf", () => {
  const result = tabRows(twoSpaces, ["w2:p1", "w1:p2", "w1:p1"]);
  expect(result.rows.map((row) => row.pane.id)).toEqual(["w2:p1", "w1:p2", "w1:p1"]);
  expect(result.rows[0]?.workspace.id).toBe("w2");
  expect(result.rows[1]?.tab.id).toBe("w1:t1");
});

// スナップショットに無いペインは行に出さない。並びの残りは詰める。
test("a pane that is no longer in the snapshot is left out", () => {
  const result = tabRows(twoSpaces, ["w1:p1", "gone:p1", "w1:p2"]);
  expect(result.rows.map((row) => row.pane.id)).toEqual(["w1:p1", "w1:p2"]);
});

// 同じスペースのペインだけなら、タブ名にスペース名を前置きしない。
test("tabs from one space are not mixed", () => {
  expect(tabRows(twoSpaces, ["w1:p1", "w1:p2"]).multiSpace).toBe(false);
  expect(tabRows(twoSpaces, ["w1:p1", "w2:p1"]).multiSpace).toBe(true);
});

// 空の列は、空の行と混ざっていないという既定を返す。
test("a leaf with no rows is empty and not mixed", () => {
  expect(tabRows(twoSpaces, [])).toEqual({ rows: [], multiSpace: false });
  expect(tabRows(twoSpaces, ["gone:p1"])).toEqual({ rows: [], multiSpace: false });
});
