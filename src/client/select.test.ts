import { expect, test } from "bun:test";
import type { AppState, PaneState } from "../server/herdr/state";
import {
  activeRowName,
  agentGlyph,
  countPanes,
  countWorkspacePanes,
  findPane,
  findPaneContext,
  findPaneRow,
  groupWorkspaces,
  initialExpanded,
  isShellPane,
  nextPaneInTab,
  paneName,
  paneRowTitle,
  soleTab,
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
      branch: "feat/board",
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

test("findPaneRow returns the original pane and its containing tab and workspace", () => {
  const workspace = state.workspaces[1];
  const tab = workspace.tabs[0];
  const pane = tab.panes[0];
  const row = findPaneRow(state, pane.id);

  expect(row?.workspace).toBe(workspace);
  expect(row?.tab).toBe(tab);
  expect(row?.pane).toBe(pane);
  expect(findPaneRow(state, "w9:p9")).toBeNull();
  expect(findPaneRow(state, null)).toBeNull();
  expect(findPaneRow({ ...state, workspaces: [] }, pane.id)).toBeNull();
});

test("findPaneContext names the workspace, tab, and branch of a pane", () => {
  expect(findPaneContext(state, "w1:p1")).toEqual({
    workspaceLabel: "hwc",
    tabLabel: "main",
    branch: "feat/board",
  });
  // git 管理外のスペースはブランチを持たない。
  expect(findPaneContext(state, "w2:p1")).toEqual({
    workspaceLabel: "hwc-verify",
    tabLabel: "main",
    branch: null,
  });
  expect(findPaneContext(state, "w9:p9")).toBeNull();
  expect(findPaneContext(state, null)).toBeNull();
});

test("the counts follow the nesting", () => {
  expect(countPanes(state)).toBe(4);
  expect(countWorkspacePanes("w1", state)).toBe(3);
});

test("a tab row is only worth showing when it gathers more than one tab", () => {
  const [multiTab, singleTab] = state.workspaces;

  expect(soleTab(multiTab)).toBeNull();
  expect(soleTab(singleTab)).toBe(singleTab.tabs[0]);
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

const plainPane = (id: string): PaneState => ({
  id,
  title: id,
  label: null,
  agent: "pi",
  agentStatus: "idle",
  focused: false,
  chat: false,
});

test("closing a pane moves the selection to the next pane in the tab", () => {
  const panes = ["w1:p1", "w1:p2", "w1:p3"].map(plainPane);

  expect(nextPaneInTab(panes, "w1:p1")).toBe("w1:p2");
  expect(nextPaneInTab(panes, "w1:p2")).toBe("w1:p3");
});

test("closing the last pane of a tab moves the selection back to the one before", () => {
  const panes = ["w1:p1", "w1:p2", "w1:p3"].map(plainPane);

  expect(nextPaneInTab(panes, "w1:p3")).toBe("w1:p2");
});

test("there is no successor when the closed pane is the only one in the tab", () => {
  expect(nextPaneInTab([plainPane("w1:p1")], "w1:p1")).toBeNull();
});

test("a hidden pane is never picked as the successor", () => {
  const panes = ["w1:p1", "w1:p2", "w1:p3", "w1:p4"].map(plainPane);
  const hidden = new Set(["w1:p2", "w1:p3"]);

  expect(nextPaneInTab(panes, "w1:p1", hidden)).toBe("w1:p4");
  // 後ろに見えるものが無ければ手前へ戻り、手前も隠れていれば移る先は無い。
  expect(nextPaneInTab(panes, "w1:p4", hidden)).toBe("w1:p1");
  expect(nextPaneInTab(panes, "w1:p2", new Set(["w1:p1", "w1:p3", "w1:p4"]))).toBeNull();
});

test("there is no successor when every other pane is hidden", () => {
  const panes = ["w1:p1", "w1:p2"].map(plainPane);

  expect(nextPaneInTab(panes, "w1:p1", new Set(["w1:p2"]))).toBeNull();
});

test("the pane name uses the Herdr label, then the title without the agent mark", () => {
  const base = {
    id: "w1:p9",
    title: null,
    label: null,
    agent: null,
    agentStatus: "idle" as const,
    focused: false,
    chat: false,
  };

  expect(paneName({ ...base, title: "π - hwc", label: "impl" })).toBe("impl");
  expect(paneName({ ...base, label: "impl", agent: "pi" })).toBe("impl");
  expect(paneName({ ...base, title: "π - hwc" })).toBe("hwc");
  expect(paneName({ ...base, title: "OC | Single letter a" })).toBe("Single letter a");
  expect(paneName({ ...base, title: "π - " })).toBe("w1:p9");
  expect(paneName({ ...base, agent: "pi" })).toBe("pi");
  expect(paneName(base)).toBe("w1:p9");
});

test("the tab chip and the detail header name a pane by its label", () => {
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

  const names = labels.map((label, index) => paneName({ ...base, id: `w1:p${index}`, label }));

  // 4 枚が同じ端末タイトルでも、タブと見出しはラベルで見分けられる。
  expect(names).toEqual(labels);
});

test("a row is titled by its name, not by the terminal title", () => {
  const base = {
    title: "π - hwc",
    label: null as string | null,
    agent: "pi" as string | null,
    agentStatus: "idle" as const,
    focused: false,
    chat: true,
  };

  expect(paneRowTitle({ ...base, id: "w1:p1", label: "impl" })).toBe("impl");
  expect(paneRowTitle({ ...base, id: "w1:p1" })).toBe("pi");
  expect(paneRowTitle({ ...base, id: "w1:p1", agent: null })).toBe("hwc");
});

test("an active row drops the workspace name the band already carries", () => {
  // 帯が場所を言うので、行は残りだけを出す。区切りは一緒に落とす。
  expect(activeRowName("demo-live-thinking", "demo-live-thinking-review")).toBe("review");
  expect(activeRowName("demo-live-thinking", "demo-live-thinking/impl")).toBe("impl");
  expect(activeRowName("demo-live-thinking", "demo-live-thinking_ui")).toBe("ui");
  expect(activeRowName("demo-live-thinking", "review-demo-live-thinking")).toBe("review");
  expect(activeRowName("demo-live-thinking", "review.demo-live-thinking")).toBe("review");
  // 大文字小文字が違っても同じ場所。
  expect(activeRowName("Demo-Live", "demo-live-review")).toBe("review");
});

test("a row keeps its name when nothing is left after the workspace name", () => {
  // 落とした結果が空なら元のラベルを使う。行の名前が消えるよりは繰り返す。
  expect(activeRowName("demo-live", "demo-live")).toBe("demo-live");
  expect(activeRowName("demo-live", "demo-live-")).toBe("demo-live-");
  // 区切りを挟まずに始まるだけの名前は、別の名前として扱う。
  expect(activeRowName("demo", "demolition")).toBe("demolition");
  // ワークスペース名が無ければ何も落とさない。
  expect(activeRowName("", "review")).toBe("review");
});
