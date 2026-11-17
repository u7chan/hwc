import { expect, test } from "bun:test";
import type { AppState, PaneState } from "../server/herdr/state";
import { allAgentPaneIds, applyDelegation, newAgentPanes, tabOfPane } from "./delegation";
import { EMPTY_SPLIT_VIEW, leafPanes, startSplitView, type SplitNode } from "./split-view";

const leaf = (pane: string): SplitNode => ({ kind: "leaf", pane });
const row = (...children: SplitNode[]): SplitNode => ({ kind: "split", dir: "row", children });
const col = (...children: SplitNode[]): SplitNode => ({ kind: "split", dir: "col", children });

function pane(id: string, agent: string | null): PaneState {
  return {
    id,
    title: null,
    label: null,
    agent,
    agentStatus: "idle",
    focused: false,
    chat: false,
  };
}

function stateWith(tabs: readonly (readonly PaneState[])[]): AppState {
  return {
    focusedWorkspaceId: "w1",
    focusedTabId: "w1:t1",
    focusedPaneId: tabs[0]?.[0]?.id ?? null,
    workspaces: [
      {
        id: "w1",
        label: "w1",
        agentStatus: "idle",
        focused: true,
        worktree: null,
        path: null,
        tabs: tabs.map((panes, index) => ({
          id: `w1:t${index + 1}`,
          label: `t${index + 1}`,
          agentStatus: "idle",
          focused: index === 0,
          panes: [...panes],
        })),
      },
    ],
    times: { workingSince: {}, finishedAt: {} },
  };
}

const view = (layout: SplitNode) => ({
  ...startSplitView(leafPanes(layout)[0] ?? null),
  openTabs: leafPanes(layout),
  layout,
});

test("only agent panes count as delegation", () => {
  const before = stateWith([[pane("w1:p1", "pi")]]);
  const after = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", null), pane("w1:p3", "claude")]]);
  expect(newAgentPanes(after, allAgentPaneIds(before)).map((item) => item.id)).toEqual(["w1:p3"]);
});

test("a pane that starts as a shell is delegated when its agent appears", () => {
  const shell = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", null)]]);
  const started = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", "claude")]]);
  expect(newAgentPanes(started, allAgentPaneIds(shell)).map((item) => item.id)).toEqual(["w1:p2"]);
});

test("an agent in a cell that is already shown does not move the layout", () => {
  const shell = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", null)]]);
  const started = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", "claude")]]);
  const shown = view(row(leaf("w1:p1"), leaf("w1:p2")));
  expect(
    applyDelegation(started, shown, newAgentPanes(started, allAgentPaneIds(shell))),
  ).toBeNull();
});

test("a pane found in another tab is not opened", () => {
  const before = stateWith([[pane("w1:p1", "pi")]]);
  const after = stateWith([[pane("w1:p1", "pi")], [pane("w1:p9", "pi")]]);
  const split = view(leaf("w1:p1"));
  expect(applyDelegation(after, split, newAgentPanes(after, allAgentPaneIds(before)))).toBeNull();
  expect(tabOfPane(after, "w1:p9")?.id).toBe("w1:t2");
});

test("the second pane grows to the right and keeps the selection", () => {
  const before = stateWith([[pane("w1:p1", "pi")]]);
  const after = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", "claude")]]);
  const result = applyDelegation(
    after,
    view(leaf("w1:p1")),
    newAgentPanes(after, allAgentPaneIds(before)),
  );
  expect(result?.entering).toBe("w1:p2");
  expect(result?.split.layout).toEqual(row(leaf("w1:p1"), leaf("w1:p2")));
  expect(result?.split.current).toBe("w1:p1");
});

test("three panes make a T, four make the 2x2 grid", () => {
  const before = stateWith([[pane("w1:p1", "pi")]]);
  const after = stateWith([
    [pane("w1:p1", "pi"), pane("w1:p2", "claude"), pane("w1:p3", "codex"), pane("w1:p4", "pi")],
  ]);
  const result = applyDelegation(
    after,
    view(leaf("w1:p1")),
    newAgentPanes(after, allAgentPaneIds(before)),
  );
  expect(result?.entering).toBe("w1:p4");
  expect(result?.split.layout).toEqual(
    row(col(leaf("w1:p1"), leaf("w1:p3")), col(leaf("w1:p2"), leaf("w1:p4"))),
  );
});

test("panes beyond four join the tabs without moving the cells", () => {
  const before = stateWith([[pane("w1:p1", "pi")]]);
  const after = stateWith([
    [
      pane("w1:p1", "pi"),
      pane("w1:p2", "claude"),
      pane("w1:p3", "codex"),
      pane("w1:p4", "pi"),
      pane("w1:p5", "pi"),
    ],
  ]);
  const result = applyDelegation(
    after,
    view(leaf("w1:p1")),
    newAgentPanes(after, allAgentPaneIds(before)),
  );
  expect(leafPanes(result?.split.layout ?? null)).toHaveLength(4);
  expect(result?.split.openTabs).toContain("w1:p5");
  // 5 枚目はセルではないので、動きの対象にもしない。
  expect(result?.entering).toBe("w1:p4");
});

test("nothing new leaves the view untouched", () => {
  const state = stateWith([[pane("w1:p1", "pi")]]);
  expect(applyDelegation(state, EMPTY_SPLIT_VIEW, [])).toBeNull();
});
