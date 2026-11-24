import { expect, test } from "bun:test";
import {
  type AppState,
  NO_TIMES,
  type PaneState,
  type WorkspaceState,
  type WorktreeState,
} from "../server/herdr/state";
import {
  activeRowName,
  agentGlyph,
  canCloseSpace,
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
  paneDisplayName,
  placeChip,
  pullRequestLabel,
  pullRequestTone,
  shortenBranchName,
  shortenPath,
  shortenPaneName,
  shortenSpaceName,
  soleTab,
  statusLabel,
  statusTone,
  tabDisplayName,
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
      path: "/home/example/hwc",
      branch: "feat/board",
      sync: {
        upstream: "origin/feat/board",
        upstreamBranch: "feat/board",
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
      path: "/home/example/hwc-verify",
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
    workspaceName: "hwc",
    parentSpaceLabel: null,
    parentSpaceName: null,
    workspacePath: "/home/example/hwc",
    tabLabel: "main",
    branch: "feat/board",
    sync: {
      upstream: "origin/feat/board",
      upstreamBranch: "feat/board",
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
    workspaceName: "hwc-verify",
    parentSpaceLabel: null,
    parentSpaceName: null,
    workspacePath: "/home/example/hwc-verify",
    tabLabel: "main",
    branch: null,
    sync: null,
    repoName: null,
  });
  expect(findPaneContext(state, "w9:p9")).toBeNull();
  expect(findPaneContext(state, null)).toBeNull();
});

test("a linked worktree takes the space it was created from", () => {
  const worktree: WorktreeState = {
    repoName: "hwc",
    repoRoot: "/srv/hwc",
    checkoutPath: "/srv/worktrees/hwc/silver-harbor-4da7",
    isLinkedWorktree: true,
    managed: true,
  };
  const host: WorkspaceState = {
    ...state.workspaces[0],
    id: "w1",
    label: "hwc",
    worktree: { ...worktree, checkoutPath: "/srv/hwc", isLinkedWorktree: false },
  };
  const linked: WorkspaceState = {
    ...state.workspaces[1],
    id: "w2",
    label: "worktree-silver-harbor-4da7",
    worktree,
  };

  expect(findPaneContext({ ...state, workspaces: [host, linked] }, "w2:p1")).toMatchObject({
    workspaceName: "silver-harbor-4da7",
    parentSpaceLabel: "hwc",
    parentSpaceName: "hwc",
  });
  // 作成元はスペースの名前。リポジトリ名ではなく、Herdr で付けたラベルを使う。
  const renamed = { ...host, label: "hwc-main" };
  expect(findPaneContext({ ...state, workspaces: [renamed, linked] }, "w2:p1")).toMatchObject({
    workspaceName: "silver-harbor-4da7",
    parentSpaceLabel: "hwc-main",
    parentSpaceName: "hwc-main",
  });
  // 作成元のスペースが閉じていればラベルは読めない。自動ラベルの元になるリポジトリ名で代える。
  expect(findPaneContext({ ...state, workspaces: [linked] }, "w2:p1")).toMatchObject({
    parentSpaceLabel: "hwc",
    parentSpaceName: "hwc",
  });
  // リポジトリ本体は、自分自身を作成元にしない。
  expect(findPaneContext({ ...state, workspaces: [host, linked] }, "w1:p1")).toMatchObject({
    parentSpaceLabel: null,
    parentSpaceName: null,
  });
});

test("a place chip drops the names the heading already shows", () => {
  expect(placeChip("Claude Code", "hwc", "silver-harbor-4da7")).toEqual({
    parent: "hwc",
    space: "silver-harbor-4da7",
  });
  expect(placeChip("Claude Code", null, "hwc")).toEqual({ parent: null, space: "hwc" });
  // 同じ名前のスペースを作成元にしていたら、繰り返さない。
  expect(placeChip("Claude Code", "hwc", "hwc")).toEqual({ parent: null, space: "hwc" });
  // 名前の無いペインは見出しが場所そのものなので、チップを出さない。
  expect(placeChip("silver-harbor-4da7", "hwc", "silver-harbor-4da7")).toBeNull();
  expect(placeChip("hwc", "hwc", "silver-harbor-4da7")).toEqual({
    parent: null,
    space: "silver-harbor-4da7",
  });
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

test("any space except the last one can be closed", () => {
  const duplicate = duplicateState();
  expect(canCloseSpace(duplicate, "w4")).toBe(true);
  expect(canCloseSpace(duplicate, "w5")).toBe(true);
  expect(canCloseSpace(unmanagedDuplicateState(), "w4")).toBe(true);
  expect(canCloseSpace({ ...duplicate, workspaces: [duplicate.workspaces[0]!] }, "w4")).toBe(false);
  expect(canCloseSpace({ ...state, workspaces: [state.workspaces[0]!] }, "w1")).toBe(false);
  expect(canCloseSpace({ ...state, workspaces: [state.workspaces[0]!] }, "w9")).toBe(false);
});

test("a native space that is not duplicated can be closed while another space exists", () => {
  const single = { ...state, workspaces: [state.workspaces[0]!, state.workspaces[1]!] };

  expect(canCloseSpace(single, "w1")).toBe(true);
  expect(canCloseSpace(single, "w2")).toBe(true);
});

test("a linked worktree managed by herdr is left to removal", () => {
  const linked: WorkspaceState = {
    ...state.workspaces[0]!,
    id: "w3",
    worktree: {
      repoName: "hwc",
      repoRoot: "/repo",
      checkoutPath: "/repo-wt",
      isLinkedWorktree: true,
      managed: true,
    },
  };
  const withLinked = { ...state, workspaces: [state.workspaces[0]!, linked] };

  expect(canCloseSpace(withLinked, "w3")).toBe(false);
  expect(canCloseSpace(withLinked, "w1")).toBe(true);
});

test("a linked checkout that herdr does not manage can be closed", () => {
  const linked: WorkspaceState = {
    ...state.workspaces[0]!,
    id: "w3",
    worktree: {
      repoName: "hwc",
      repoRoot: "/repo",
      checkoutPath: "/repo-wt",
      isLinkedWorktree: true,
      managed: false,
    },
  };
  const withLinked = { ...state, workspaces: [state.workspaces[0]!, linked] };

  expect(canCloseSpace(withLinked, "w3")).toBe(true);
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

// 名前の規則は 1 つ。タブ・セル見出し・一覧の 1 段目は、すべてこの値から作る。
test("the display name uses the Herdr label, then the agent, then the terminal title", () => {
  const base: PaneState = {
    id: "w1:p9",
    title: null,
    label: null,
    agent: null,
    agentStatus: "idle",
    focused: false,
    chat: false,
  };
  const cases: readonly [string, Partial<PaneState>, string][] = [
    ["label", { label: "impl", agent: "pi", title: "π - hwc" }, "impl"],
    // 端末タイトルは同じリポジトリのペインで同じ値になるので、エージェント名を先に採る。
    // 以前は端末タイトルを先に見たため、この組み合わせだけが変更を検出できる。
    ["agent over the title", { agent: "pi", title: "π - hwc" }, "pi"],
    ["agent without a title", { agent: "claude" }, "claude"],
    ["title without a label or an agent", { title: "π - hwc" }, "hwc"],
    ["the Claude mark in the title", { title: "OC | Single letter a" }, "Single letter a"],
    ["a title that is only the mark", { title: "π - " }, "シェル"],
    ["a shell without a name", {}, "シェル"],
  ];

  for (const [name, pane, expected] of cases) {
    expect({ name, value: paneDisplayName({ ...base, ...pane }) }).toEqual({
      name,
      value: expected,
    });
  }
});

test("a shell without a name is called シェル, not its pane id", () => {
  const base: PaneState = {
    id: "w1:p9",
    title: null,
    label: null,
    agent: null,
    agentStatus: "idle",
    focused: false,
    chat: false,
  };

  expect(paneDisplayName(base)).toBe("シェル");
  expect(paneDisplayName({ ...base, label: "notes" })).toBe("notes");
});

// 経路ごとに表示用の変換が違うので、期待値も経路ごとに分けて書く。
test("a tab shows the display name", () => {
  const pane: PaneState = {
    id: "w1:p9",
    title: "π - feat-client-api-connection",
    label: null,
    agent: "pi",
    agentStatus: "idle",
    focused: false,
    chat: false,
  };

  // 以前は端末タイトルを先に見たので、このタブは feat-client-api-connection だった。
  expect(tabDisplayName(paneDisplayName(pane), state.workspaces[0]!)).toBe("pi");
});

test("a cell header shows the display name", () => {
  const workspace = state.workspaces[0]!;
  const pane: PaneState = {
    id: "w1:p9",
    title: "π - feat-client-api-connection",
    label: null,
    agent: "pi",
    agentStatus: "idle",
    focused: false,
    chat: false,
  };

  expect(shortenPaneName(paneDisplayName(pane), workspace.label, shortenSpaceName(workspace))).toBe(
    "pi",
  );
});

test("an active row shows the display name without the place", () => {
  const base: PaneState = {
    id: "w1:p9",
    title: "π - hwc",
    label: null,
    agent: "pi",
    agentStatus: "idle",
    focused: false,
    chat: false,
  };

  expect(activeRowName("hwc", paneDisplayName(base))).toBe("pi");
  // 帯がスペース名を持つので、行では名前の先頭から場所の部分を落とす。
  expect(
    activeRowName("hwc", paneDisplayName({ ...base, agent: null, title: "π - hwc-api" })),
  ).toBe("api");
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

test("a linked worktree drops the generated prefix where the name is short", () => {
  const worktree: WorktreeState = {
    repoName: "hwc",
    repoRoot: "/srv/hwc",
    checkoutPath: "/srv/worktrees/hwc/x",
    isLinkedWorktree: true,
    managed: true,
  };
  const linked = (label: string, value: WorktreeState | null = worktree): WorkspaceState => ({
    ...state.workspaces[0],
    label,
    worktree: value,
  });

  expect(shortenSpaceName(linked("worktree-silver-cloud-c4cf"))).toBe("silver-cloud-c4cf");
  expect(tabDisplayName("worktree-silver-cloud-c4cf", linked("worktree-silver-cloud-c4cf"))).toBe(
    "silver-cloud-c4cf",
  );
  expect(
    shortenPaneName(
      "worktree-silver-cloud-c4cf",
      "worktree-silver-cloud-c4cf",
      "silver-cloud-c4cf",
    ),
  ).toBe("silver-cloud-c4cf");
  // ラベルの無いペインは端末タイトルがスペース名と同じになる。一覧も名前から場所を落とすが、
  // 同長なので、タブや見出しのように省略されずに残る（差はこの Issue では残す）。
  expect(activeRowName("worktree-silver-cloud-c4cf", "worktree-silver-cloud-c4cf")).toBe(
    "worktree-silver-cloud-c4cf",
  );
  // ペインに付いた別名はそのまま。
  expect(tabDisplayName("pr-review", linked("worktree-silver-cloud-c4cf"))).toBe("pr-review");
  expect(shortenPaneName("pr-review", "worktree-silver-cloud-c4cf", "silver-cloud-c4cf")).toBe(
    "pr-review",
  );
  // ユーザーが付けた名前、Herdr の生成規則に合わない名前はそのまま。
  expect(shortenSpaceName(linked("review"))).toBe("review");
  expect(shortenSpaceName(linked("worktree-"))).toBe("worktree-");
  // リポジトリ本体と、worktree を持たないスペースは対象外。
  expect(shortenSpaceName(linked("worktree-x", null))).toBe("worktree-x");
  expect(shortenSpaceName(linked("worktree-x", { ...worktree, isLinkedWorktree: false }))).toBe(
    "worktree-x",
  );

  // ブランチも同じく、linked worktree の `worktree/` だけを表示から落とす。
  expect(shortenBranchName(linked("x"), "worktree/quiet-stone-1bb5")).toBe("quiet-stone-1bb5");
  expect(shortenBranchName(linked("x"), "feat/quiet-stone")).toBe("feat/quiet-stone");
  expect(shortenBranchName(linked("x", null), "worktree/quiet-stone-1bb5")).toBe(
    "worktree/quiet-stone-1bb5",
  );
  expect(
    shortenBranchName(linked("x", { ...worktree, isLinkedWorktree: false }), "worktree/x"),
  ).toBe("worktree/x");
  // 落とした結果が空なら元のブランチを使う。
  expect(shortenBranchName(linked("x"), "worktree/")).toBe("worktree/");
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
