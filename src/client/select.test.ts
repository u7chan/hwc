import { expect, test } from "bun:test";
import type { AppState } from "../server/herdr/state";
import {
  agentGlyph,
  countPanes,
  countWorkspacePanes,
  findPane,
  findPaneContext,
  canMovePane,
  countGroupPanes,
  groupWorkspaces,
  initialExpanded,
  isShellPane,
  movePane,
  movePaneStep,
  paneName,
  paneSubLabel,
  removePane,
  splitPanes,
  statusLabel,
  statusTone,
} from "./select";

const state: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "working",
      focused: true,
      worktree: null,
      tabs: [
        {
          id: "w1:t1",
          label: "main",
          agentStatus: "working",
          focused: true,
          panes: [
            {
              id: "w1:p1",
              title: "π - hwc",
              label: null,
              agent: "pi",
              agentStatus: "working",
              focused: true,
              chat: false,
            },
            {
              id: "w1:p2",
              title: null,
              label: null,
              agent: null,
              agentStatus: "unknown",
              focused: false,
              chat: false,
            },
          ],
        },
        {
          id: "w1:t2",
          label: "verify",
          agentStatus: "idle",
          focused: false,
          panes: [
            {
              id: "w1:p3",
              title: "bash",
              label: null,
              agent: null,
              agentStatus: "idle",
              focused: false,
              chat: false,
            },
          ],
        },
      ],
    },
    {
      id: "w2",
      label: "hwc-verify",
      agentStatus: "blocked",
      focused: false,
      worktree: null,
      tabs: [
        {
          id: "w2:t1",
          label: "main",
          agentStatus: "blocked",
          focused: false,
          panes: [
            {
              id: "w2:p1",
              title: "bash",
              label: null,
              agent: null,
              agentStatus: "blocked",
              focused: false,
              chat: false,
            },
          ],
        },
      ],
    },
  ],
};

test("findPane resolves a pane from its id", () => {
  expect(findPane(state, "w1:p2")?.id).toBe("w1:p2");
  expect(findPane(state, "w9:p9")).toBeNull();
  expect(findPane(state, null)).toBeNull();
});

test("findPaneContext names the workspace and tab of a pane", () => {
  expect(findPaneContext(state, "w2:p1")).toEqual({
    workspaceLabel: "hwc-verify",
    tabLabel: "main",
  });
  expect(findPaneContext(state, "w9:p9")).toBeNull();
});

test("the counts follow the nesting", () => {
  expect(countPanes(state)).toBe(4);
  expect(countWorkspacePanes("w1", state)).toBe(3);
});

test("closing a pane leaves its neighbours alone", () => {
  const after = removePane(state, "w1:p2");

  expect(after.workspaces[0].tabs[0].panes.map((pane) => pane.id)).toEqual(["w1:p1"]);
  expect(countPanes(after)).toBe(3);
  expect(findPane(after, "w1:p2")).toBeNull();
});

test("closing the last pane of a tab drops the tab, then the workspace", () => {
  const afterTab = removePane(state, "w1:p3");
  expect(afterTab.workspaces[0].tabs.map((tab) => tab.id)).toEqual(["w1:t1"]);

  const afterWorkspace = removePane(state, "w2:p1");
  expect(afterWorkspace.workspaces.map((workspace) => workspace.id)).toEqual(["w1"]);
});

test("a pane can be dragged into another tab", () => {
  const after = movePane(state, "w1:p1", "w1:t2", 0);

  expect(after.workspaces[0].tabs[0].panes.map((pane) => pane.id)).toEqual(["w1:p2"]);
  expect(after.workspaces[0].tabs[1].panes.map((pane) => pane.id)).toEqual(["w1:p1", "w1:p3"]);
});

test("reordering inside a tab accounts for the pane leaving its slot", () => {
  const down = movePane(state, "w1:p1", "w1:t1", 2);
  expect(down.workspaces[0].tabs[0].panes.map((pane) => pane.id)).toEqual(["w1:p2", "w1:p1"]);

  const up = movePane(state, "w1:p2", "w1:t1", 0);
  expect(up.workspaces[0].tabs[0].panes.map((pane) => pane.id)).toEqual(["w1:p2", "w1:p1"]);
});

test("a pane moves one step along the list, across tabs", () => {
  const down = movePaneStep(state, "w1:p1", 1);
  expect(down.workspaces[0].tabs[0].panes.map((pane) => pane.id)).toEqual(["w1:p2", "w1:p1"]);

  // タブの境目を越えると、隣のタブの頭に入る。
  const across = movePaneStep(state, "w1:p2", 1);
  expect(across.workspaces[0].tabs[0].panes.map((pane) => pane.id)).toEqual(["w1:p1"]);
  expect(across.workspaces[0].tabs[1].panes.map((pane) => pane.id)).toEqual(["w1:p3", "w1:p2"]);
});

test("the ends of the list have no further step", () => {
  expect(canMovePane(state, "w1:p1", -1)).toBe(false);
  expect(canMovePane(state, "w1:p1", 1)).toBe(true);
  expect(canMovePane(state, "w2:p1", 1)).toBe(false);
  expect(canMovePane(state, "w9:p9", 1)).toBe(false);
  expect(movePaneStep(state, "w1:p1", -1)).toEqual(state);
});

test("moving a pane that does not exist changes nothing", () => {
  expect(movePane(state, "w9:p9", "w1:t1", 0)).toEqual(state);
});

test("closing an unknown pane changes nothing", () => {
  expect(removePane(state, "w9:p9")).toEqual(state);
});

test("status maps to a tone and a label", () => {
  expect(statusTone("working")).toBe("active");
  expect(statusTone("blocked")).toBe("attention");
  expect(statusTone("done")).toBe("success");
  expect(statusTone("idle")).toBe("neutral");
  expect(statusTone("unknown")).toBe("neutral");

  expect(statusLabel("working")).toBe("実行中");
  expect(statusLabel("blocked")).toBe("要対応");
  expect(statusLabel("done")).toBe("完了");
  expect(statusLabel("idle")).toBe("待機");
  expect(statusLabel("unknown")).toBe("不明");
});

test("the focused workspace and the focused tab start expanded", () => {
  expect([...initialExpanded(state)]).toEqual(["w1", "w1:t1"]);
});

test("workspaces of the same repo are grouped under the repo", () => {
  const root = {
    ...state.workspaces[0],
    worktree: {
      repoName: "hwc",
      repoRoot: "/repo",
      checkoutPath: "/repo",
      isLinkedWorktree: false,
    },
  };
  const linked = {
    ...state.workspaces[1],
    worktree: {
      repoName: "hwc",
      repoRoot: "/repo",
      checkoutPath: "/repo-wt",
      isLinkedWorktree: true,
    },
  };
  const flat = { ...state, workspaces: [root, linked, state.workspaces[1]] };
  const groups = groupWorkspaces(flat.workspaces);

  // 本体を親に、linked worktree と git 管理外はそれぞれの位置に残す。
  expect(groups.map((group) => [group.repoName, group.host?.id ?? null])).toEqual([
    ["hwc", "w1"],
    [null, "w2"],
  ]);
  expect(groups[0].linked.map((workspace) => workspace.id)).toEqual(["w2"]);
  expect(countGroupPanes(groups[0], flat)).toBe(4);
});

test("a repo without a main checkout still forms one group", () => {
  const linked = {
    ...state.workspaces[1],
    worktree: {
      repoName: "hwc",
      repoRoot: "/repo",
      checkoutPath: "/repo-wt",
      isLinkedWorktree: true,
    },
  };
  const groups = groupWorkspaces([linked]);

  expect(groups).toHaveLength(1);
  expect(groups[0].host).toBeNull();
  expect(groups[0].linked.map((workspace) => workspace.id)).toEqual(["w2"]);
  expect([...initialExpanded({ ...state, workspaces: [linked] })]).toContain("repo:hwc");
});

test("agentGlyph picks the icon for a known agent", () => {
  expect(agentGlyph("pi")).toBe("pi");
  expect(agentGlyph("claude")).toBe("claude");
  expect(agentGlyph("codex")).toBe("codex");
  expect(agentGlyph("opencode")).toBe("opencode");
});

test("agentGlyph matches the agent name loosely", () => {
  expect(agentGlyph("Claude Code")).toBe("claude");
  expect(agentGlyph("openai-codex")).toBe("codex");
  expect(agentGlyph(null)).toBe("generic");
  expect(agentGlyph("vim")).toBe("generic");
});

test("a pane without an agent is a shell", () => {
  expect(
    isShellPane({
      id: "w1:p3",
      title: "bash",
      label: null,
      agent: null,
      agentStatus: "idle",
      focused: false,
      chat: false,
    }),
  ).toBe(true);
  expect(
    isShellPane({
      id: "w1:p1",
      title: "π - hwc",
      label: null,
      agent: "pi",
      agentStatus: "idle",
      focused: false,
      chat: true,
    }),
  ).toBe(false);
});

test("the split view shows at most four panes of the tab", () => {
  const panes = [1, 2, 3, 4, 5].map((index) => ({
    id: `w1:p${index}`,
    title: `p${index}`,
    label: null,
    agent: "pi",
    agentStatus: "idle" as const,
    focused: false,
    chat: false,
  }));

  expect(splitPanes(panes, "w1:p2").map((pane) => pane.id)).toEqual([
    "w1:p1",
    "w1:p2",
    "w1:p3",
    "w1:p4",
  ]);
  // 画面に入らないペインを選んだら、最後の枠と入れ替えてでも見せる。
  expect(splitPanes(panes, "w1:p5").map((pane) => pane.id)).toEqual([
    "w1:p1",
    "w1:p2",
    "w1:p3",
    "w1:p5",
  ]);
  expect(splitPanes(panes.slice(0, 3), "w1:p9")).toHaveLength(3);
});

test("hidden panes stay out of the split until they are opened", () => {
  const panes = [1, 2, 3].map((index) => ({
    id: `w1:p${index}`,
    title: `p${index}`,
    label: null,
    agent: "pi",
    agentStatus: "idle" as const,
    focused: false,
    chat: false,
  }));
  const hidden = new Set(["w1:p2"]);

  expect(splitPanes(panes, "w1:p1", hidden).map((pane) => pane.id)).toEqual(["w1:p1", "w1:p3"]);
  // 隠したペインを開いている間は出す。読んでいるものが消えるほうが困る。
  expect(splitPanes(panes, "w1:p2", hidden).map((pane) => pane.id)).toEqual([
    "w1:p1",
    "w1:p2",
    "w1:p3",
  ]);
  // 隠れて 1 枚だけ残っても、その 1 枚は返す。
  expect(splitPanes(panes, "w1:p1", new Set(["w1:p2", "w1:p3"])).map((pane) => pane.id)).toEqual([
    "w1:p1",
  ]);
  expect(splitPanes(panes, "w1:p1", new Set())).toHaveLength(3);
});

test("the pane name prefers the terminal title, then the Herdr label", () => {
  const base = {
    id: "w1:p9",
    title: null,
    label: null,
    agent: null,
    agentStatus: "idle" as const,
    focused: false,
    chat: false,
  };

  expect(paneName({ ...base, title: "π - hwc", label: "impl" })).toBe("π - hwc");
  expect(paneName({ ...base, label: "impl", agent: "pi" })).toBe("impl");
  expect(paneName({ ...base, agent: "pi" })).toBe("pi");
  expect(paneName(base)).toBe("w1:p9");
});

test("the label is shown as a subtitle only when it differs from the name", () => {
  const base = {
    id: "w1:p9",
    title: null,
    label: null,
    agent: null,
    agentStatus: "idle" as const,
    focused: false,
    chat: false,
  };

  // 4 つのペインが同じ端末タイトルでも、一覧ではラベルで見分けられる。
  expect(paneSubLabel({ ...base, title: "π - hwc", label: "impl" })).toBe("impl");
  expect(paneSubLabel({ ...base, label: "impl" })).toBeNull();
  expect(paneSubLabel({ ...base, title: "π - hwc" })).toBeNull();
});

test("the tab chip and the detail header tell panes apart by their label", () => {
  const base = {
    id: "w1:p9",
    title: "π - feat-client-api-connection",
    label: null,
    agent: "pi",
    agentStatus: "idle" as const,
    focused: false,
    chat: false,
  };
  const labels = [
    "orchestrator-issue14",
    "impl-client-api",
    "review-client-api",
    "ui-tester-client-api",
  ];

  const shown = labels.map((label, index) => {
    const pane = { ...base, id: `w1:p${index}`, label };
    return { name: paneName(pane), sub: paneSubLabel(pane) };
  });

  // 名前は同じでも、副題で 4 枚を見分けられる。
  expect(new Set(shown.map((pane) => pane.name))).toEqual(
    new Set(["π - feat-client-api-connection"]),
  );
  expect(shown.map((pane) => pane.sub)).toEqual(labels);
});

test("a label that repeats the name is not shown twice", () => {
  const pane = {
    id: "w1:p9",
    title: null,
    label: "bash",
    agent: null,
    agentStatus: "idle" as const,
    focused: false,
    chat: false,
  };

  expect(paneName(pane)).toBe("bash");
  expect(paneSubLabel(pane)).toBeNull();
  expect(paneSubLabel({ ...pane, agent: "bash" })).toBeNull();
});
