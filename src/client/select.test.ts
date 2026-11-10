import { expect, test } from "bun:test";
import {
  type AppState,
  NO_TIMES,
  type PaneState,
  type WorkspaceState,
} from "../server/herdr/state";
import {
  activeRowName,
  agentGlyph,
  canCloseDuplicateSpace,
  countPanes,
  countTabAgents,
  countWorkspaceAgents,
  countWorkspacePanes,
  findPane,
  findPaneContext,
  findPaneRow,
  groupIds,
  groupMembers,
  groupWorkspaces,
  initialExpanded,
  isShellPane,
  markedParentPaneIds,
  mostUrgentStatus,
  paneName,
  paneRowTitle,
  parentPaneOf,
  pullRequestLabel,
  pullRequestTone,
  shortenPath,
  soleTab,
  statusLabel,
  statusTone,
} from "./select";

const state: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  times: NO_TIMES,
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "working",
      focused: true,
      worktree: null,
      branch: "feat/board",
      sync: {
        upstream: "origin/feat/board",
        ahead: 1,
        behind: 0,
        hasRemote: true,
        repoUrl: "https://github.com/o/r",
      },
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
    workspaceId: "w1",
    workspaceLabel: "hwc",
    tabLabel: "main",
    branch: "feat/board",
    sync: {
      upstream: "origin/feat/board",
      ahead: 1,
      behind: 0,
      hasRemote: true,
      repoUrl: "https://github.com/o/r",
    },
    repoName: null,
  });
  // git 管理外のスペースはブランチを持たない。
  expect(findPaneContext(state, "w2:p1")).toEqual({
    workspaceId: "w2",
    workspaceLabel: "hwc-verify",
    tabLabel: "main",
    branch: null,
    sync: null,
    repoName: null,
  });
  expect(findPaneContext(state, "w9:p9")).toBeNull();
  expect(findPaneContext(state, null)).toBeNull();
});

test("the counts follow the nesting", () => {
  expect(countPanes(state)).toBe(4);
  expect(countWorkspacePanes("w1", state)).toBe(3);
});

test("agents are counted apart from shells", () => {
  const [multiTab, singleTab] = state.workspaces;

  expect(countWorkspaceAgents(multiTab)).toBe(1);
  expect(countTabAgents(multiTab.tabs[0])).toBe(1);
  expect(countTabAgents(multiTab.tabs[1])).toBe(0);
  // シェルだけのスペース。ペインの agentStatus が blocked でも、エージェントはいない。
  expect(countWorkspaceAgents(singleTab)).toBe(0);
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
      managed: true,
    },
  };
  const linked = {
    ...state.workspaces[1],
    worktree: {
      repoName: "hwc",
      repoRoot: "/repo",
      checkoutPath: "/repo-wt",
      isLinkedWorktree: true,
      managed: true,
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
      managed: true,
    },
  };
  const groups = groupWorkspaces([linked]);

  expect(groups).toHaveLength(1);
  expect(groups[0].host).toBeNull();
  expect(groups[0].linked.map((workspace) => workspace.id)).toEqual(["w2"]);
  expect([...initialExpanded({ ...state, workspaces: [linked] })]).toContain("repo:hwc");
});

const PLACE_KEY = "place:%2Fwork%2Fmypi:mypi";

function duplicateState(): AppState {
  return {
    ...state,
    workspaces: ["w4", "w5"].map((id, index) => ({
      ...state.workspaces[1]!,
      id,
      label: "mypi",
      path: "/work/mypi",
      focused: index === 0,
      tabs: [],
    })),
  };
}

function unmanagedDuplicateState(): AppState {
  const duplicate = duplicateState();
  return {
    ...duplicate,
    workspaces: duplicate.workspaces.map((workspace) => ({
      ...workspace,
      worktree: {
        repoName: "mypi",
        repoRoot: "/work",
        checkoutPath: "/work/mypi",
        isLinkedWorktree: false,
        managed: false,
      },
    })),
  };
}

test("native spaces with the same path and label are grouped as one place", () => {
  const duplicate = duplicateState();
  const groups = groupWorkspaces(duplicate.workspaces);

  expect(groups).toHaveLength(1);
  expect(groups[0].place).toEqual({
    key: PLACE_KEY,
    path: "/work/mypi",
    label: "mypi",
  });
  expect(groups[0].host?.id).toBe("w4");
  expect(groups[0].linked.map((workspace) => workspace.id)).toEqual(["w5"]);
  expect(groupMembers(groups[0]).map((workspace) => workspace.id)).toEqual(["w4", "w5"]);
});

test("unmanaged git duplicates are grouped as a place, not a repo", () => {
  const duplicate = unmanagedDuplicateState();
  const groups = groupWorkspaces(duplicate.workspaces);

  expect(groups).toHaveLength(1);
  expect(groups[0].place?.key).toBe(PLACE_KEY);
  expect(groups[0].repoName).toBeNull();
});

test("unmanaged git spaces at different places still group by repo", () => {
  const duplicate = duplicateState();
  const worktree = {
    repoName: "mypi",
    repoRoot: "/work",
    checkoutPath: "/work/mypi",
    isLinkedWorktree: false,
    managed: false,
  };
  const first = { ...duplicate.workspaces[0]!, path: "/work/a", worktree };
  const second = { ...duplicate.workspaces[1]!, id: "w5", path: "/work/b", worktree };
  const groups = groupWorkspaces([first, second]);

  expect(groups).toHaveLength(1);
  expect(groups[0].repoName).toBe("mypi");
  expect(groups[0].place).toBeNull();
  expect(groupMembers(groups[0]).map((workspace) => workspace.id)).toEqual(["w4", "w5"]);
});

test("the same path with a different label stays separate", () => {
  const duplicate = duplicateState();
  const first = duplicate.workspaces[0]!;
  const groups = groupWorkspaces([first, { ...duplicate.workspaces[1]!, label: "mypi review" }]);

  expect(groups).toHaveLength(2);
  expect(groups.every((group) => group.place === null)).toBe(true);
});

test("the same label at a different path stays separate", () => {
  const duplicate = duplicateState();
  const first = duplicate.workspaces[0]!;
  const groups = groupWorkspaces([
    first,
    { ...duplicate.workspaces[1]!, path: "/work/other/mypi" },
  ]);

  expect(groups).toHaveLength(2);
  expect(groups.every((group) => group.place === null)).toBe(true);
});

test("a single native space is not a place group", () => {
  const groups = groupWorkspaces([duplicateState().workspaces[0]!]);

  expect(groups).toHaveLength(1);
  expect(groups[0].place).toBeNull();
});

test("only duplicate native spaces can be closed", () => {
  const duplicate = duplicateState();
  expect(canCloseDuplicateSpace(duplicate, "w4")).toBe(true);
  expect(canCloseDuplicateSpace(duplicate, "w5")).toBe(true);
  expect(canCloseDuplicateSpace(unmanagedDuplicateState(), "w4")).toBe(true);
  expect(
    canCloseDuplicateSpace({ ...duplicate, workspaces: [duplicate.workspaces[0]!] }, "w4"),
  ).toBe(false);
  expect(canCloseDuplicateSpace(state, "w1")).toBe(false);
  expect(canCloseDuplicateSpace(state, "w9")).toBe(false);
});

test("a place group opens when a member is focused and is known to the tree", () => {
  const duplicate = duplicateState();
  expect(initialExpanded(duplicate).has(PLACE_KEY)).toBe(true);
  expect(groupIds(duplicate).has(PLACE_KEY)).toBe(true);

  const single = { ...duplicate, workspaces: [duplicate.workspaces[0]!] };
  expect(groupIds(single).has(PLACE_KEY)).toBe(false);
});

test("the place status is the most urgent member status", () => {
  expect(mostUrgentStatus(["idle", "working"])).toBe("working");
  expect(mostUrgentStatus(["done", "blocked"])).toBe("blocked");
  expect(mostUrgentStatus(["unknown", "idle"])).toBe("idle");
  expect(mostUrgentStatus([])).toBe("unknown");
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
  expect(paneName({ ...base, title: "π - " })).toBe("シェル");
  expect(paneName({ ...base, agent: "pi" })).toBe("pi");
});

test("a shell without a name is called シェル, not its pane id", () => {
  const base = {
    id: "w1:p9",
    title: null,
    label: null,
    agent: null,
    agentStatus: "idle" as const,
    focused: false,
    chat: false,
  };

  expect(paneName(base)).toBe("シェル");
  expect(paneName({ ...base, label: "notes" })).toBe("notes");
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
  expect(paneRowTitle({ ...base, id: "w1:p1", title: null, agent: null })).toBe("シェル");
});

test("a long path keeps the tail that identifies the place", () => {
  expect(shortenPath("/srv/app")).toBe("/srv/app");
  expect(shortenPath("/home/dev/.herdr/worktrees/hwc/worktree-silver-cloud-c4cf")).toBe(
    "…/hwc/worktree-silver-cloud-c4cf",
  );
  expect(shortenPath("/home/example/work/acme-dashboard/worktrees/feature-empty-state")).toBe(
    "…/worktrees/feature-empty-state",
  );
});

test("a long path without a separator in the tail keeps its last characters", () => {
  const name = "a".repeat(40);
  expect(shortenPath(`/${name}`)).toBe(`…${name.slice(-35)}`);

  // 絵文字を途中で割らない。
  const emoji = "📁".repeat(40);
  expect(shortenPath(`/${emoji}`)).toBe(`…${emoji.slice(0, 35 * 2)}`);
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

test("the list shows a chip for open and merged, and none for closed", () => {
  // マージ後もワークツリーは残る。終わったタスクを取り違えないよう、merged にも印を出す。
  expect(pullRequestTone("OPEN")).toBe("open");
  expect(pullRequestTone("MERGED")).toBe("merged");
  expect(pullRequestTone("CLOSED")).toBeNull();
});

test("the merged chip says the state when read aloud", () => {
  const pullRequest = {
    number: 481,
    url: "https://github.com/example/acme-dashboard/pull/481",
    title: "Add an empty state to the dashboard",
  };

  expect(pullRequestLabel({ ...pullRequest, state: "OPEN" })).toBe("PR #481 を GitHub で開く");
  expect(pullRequestLabel({ ...pullRequest, state: "MERGED" })).toBe(
    "PR #481（マージ済み）を GitHub で開く",
  );
});

function parentPane(
  id: string,
  agent: string | null,
  agentStatus: PaneState["agentStatus"] = "idle",
): PaneState {
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

function parentWorkspace(id: string, tabs: readonly (readonly PaneState[])[]): WorkspaceState {
  return {
    id,
    label: id,
    agentStatus: "unknown",
    focused: false,
    worktree: null,
    tabs: tabs.map((panes, index) => ({
      id: `${id}:t${index + 1}`,
      label: String(index + 1),
      agentStatus: "unknown" as const,
      focused: false,
      panes: [...panes],
    })),
  };
}

test("the parent is the first agent pane from the left", () => {
  const workspace = parentWorkspace("w1", [
    [
      parentPane("w1:p1", null, "idle"),
      parentPane("w1:p2", "pi", "done"),
      parentPane("w1:p3", "codex", "idle"),
    ],
    [parentPane("w1:p4", "pi", "working")],
  ]);

  // シェルは飛ばし、左端のタブの先頭から見る。別タブの先頭エージェントは親にしない。
  expect(parentPaneOf(workspace)?.id).toBe("w1:p2");
});

test("a workspace without agents has no parent", () => {
  const workspace = parentWorkspace("w1", [[parentPane("w1:p1", null, "idle")]]);
  expect(parentPaneOf(workspace)).toBeNull();
});

test("the parent search skips a tab with no agents", () => {
  const workspace = parentWorkspace("w1", [
    [parentPane("w1:p1", null, "idle")],
    [parentPane("w1:p2", "pi", "done")],
  ]);
  expect(parentPaneOf(workspace)?.id).toBe("w1:p2");
});

test("the parent mark is only needed when the space has more than one agent", () => {
  const state: AppState = {
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
    times: NO_TIMES,
    workspaces: [
      parentWorkspace("w1", [
        [parentPane("w1:p1", "pi", "done"), parentPane("w1:p2", "codex", "working")],
      ]),
      parentWorkspace("w2", [[parentPane("w2:p1", "pi", "working")]]),
      parentWorkspace("w3", [
        [parentPane("w3:p1", null, "idle"), parentPane("w3:p2", "pi", "done")],
        [parentPane("w3:p3", "codex", "idle")],
      ]),
      parentWorkspace("w4", [[parentPane("w4:p1", null, "idle")]]),
    ],
  };

  // 1 枚だけのスペースは親が自明なので出さない。シェルは親にならない。
  expect([...markedParentPaneIds(state)]).toEqual(["w1:p1", "w3:p2"]);
});
