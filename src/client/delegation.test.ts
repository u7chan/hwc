import { expect, test } from "bun:test";
import type { AppState, PaneState } from "../server/herdr/state";
import { allAgentPaneIds, applyDelegation, newAgentPanes, tabOfPane } from "./delegation";
import {
  EMPTY_SPLIT_VIEW,
  leafOfPane,
  readingOrder,
  startSplitView,
  type SplitLeaf,
  type SplitNode,
} from "./split-view";

let testLeafSeq = 0;
const leaf = (tabs: readonly string[], active: string = tabs[0] ?? ""): SplitLeaf => ({
  kind: "leaf",
  id: `test-${++testLeafSeq}`,
  tabs,
  active,
});
const row = (...children: SplitNode[]): SplitNode => ({ kind: "split", dir: "row", children });
const col = (...children: SplitNode[]): SplitNode => ({ kind: "split", dir: "col", children });

// 新しい葉の id は毎回変わるので、配置の比較では id を落とす。
const plainNode = (node: SplitNode | null): SplitNode | null => {
  if (node === null) return null;
  if (node.kind === "leaf") return { kind: "leaf", id: "", tabs: node.tabs, active: node.active };
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.flatMap((child) => {
      const plain = plainNode(child);
      return plain === null ? [] : [plain];
    }),
  };
};

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

const view = (
  layout: SplitNode,
  current: string | null = readingOrder(layout)[0]?.active ?? null,
) => ({
  ...startSplitView(null),
  current,
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

test("an agent in a leaf that is already shown does not move the layout", () => {
  const shell = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", null)]]);
  const started = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", "claude")]]);
  const shown = view(leaf(["w1:p1", "w1:p2"], "w1:p1"));
  expect(
    applyDelegation(started, shown, newAgentPanes(started, allAgentPaneIds(shell))),
  ).toBeNull();
});

test("a leaf counts as visible through a non-active tab", () => {
  const shell = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", null)]]);
  // 同じ Herdr タブの p2 は active ではないが、葉の tabs にある。
  const started = stateWith([
    [pane("w1:p1", "pi"), pane("w1:p2", "claude"), pane("w1:p3", "codex")],
  ]);
  const shown = view(leaf(["w1:p1", "w1:p2"], "w1:p1"));
  const result = applyDelegation(started, shown, newAgentPanes(started, allAgentPaneIds(shell)));
  expect(result?.entering).toBe("w1:p3");
  expect(readingOrder(result?.split.layout ?? null).map((item) => item.tabs)).toEqual([
    ["w1:p1", "w1:p2"],
    ["w1:p3"],
  ]);
});

test("a pane found in another Herdr tab is not opened", () => {
  const before = stateWith([[pane("w1:p1", "pi")]]);
  const after = stateWith([[pane("w1:p1", "pi")], [pane("w1:p9", "pi")]]);
  const split = view(leaf(["w1:p1"]));
  expect(applyDelegation(after, split, newAgentPanes(after, allAgentPaneIds(before)))).toBeNull();
  expect(tabOfPane(after, "w1:p9")?.id).toBe("w1:t2");
});

test("the second pane grows to the right and keeps the selection", () => {
  const before = stateWith([[pane("w1:p1", "pi")]]);
  const after = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", "claude")]]);
  const result = applyDelegation(
    after,
    view(leaf(["w1:p1"])),
    newAgentPanes(after, allAgentPaneIds(before)),
  );
  expect(result?.entering).toBe("w1:p2");
  expect(plainNode(result?.split.layout ?? null)).toEqual(
    plainNode(row(leaf(["w1:p1"]), leaf(["w1:p2"]))),
  );
  expect(result?.split.current).toBe("w1:p1");
});

test("the new pane splits the focused leaf", () => {
  const before = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", "claude")]]);
  const after = stateWith([[pane("w1:p1", "pi"), pane("w1:p2", "claude"), pane("w1:p3", "codex")]]);
  const shown = view(row(leaf(["w1:p1"]), leaf(["w1:p2"])), "w1:p2");
  const result = applyDelegation(after, shown, newAgentPanes(after, allAgentPaneIds(before)));
  expect(result?.entering).toBe("w1:p3");
  // p2 の葉は親が row なので、右ではなく下へ割る。
  expect(plainNode(result?.split.layout ?? null)).toEqual(
    plainNode(row(leaf(["w1:p1"]), col(leaf(["w1:p2"]), leaf(["w1:p3"])))),
  );
  expect(result?.split.current).toBe("w1:p2");
});

test("a fifth pane joins the tabs instead of adding a cell", () => {
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
    view(leaf(["w1:p1"])),
    newAgentPanes(after, allAgentPaneIds(before)),
  );
  expect(readingOrder(result?.split.layout ?? null)).toHaveLength(4);
  // 4 セルが埋まったので、フォーカス中の葉（p1）の末尾へタブとして足す。
  expect(leafOfPane(result?.split.layout ?? null, "w1:p1")?.tabs).toContain("w1:p5");
  expect(result?.entering).toBe("w1:p4");
});

test("nothing new leaves the view untouched", () => {
  const state = stateWith([[pane("w1:p1", "pi")]]);
  expect(applyDelegation(state, EMPTY_SPLIT_VIEW, [])).toBeNull();
});
