import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrPane, HerdrTab, HerdrWorkspace } from "../../src/server/herdr/contract";
import type { FakeContext } from "./context";

export type SetAgentStatus = (
  paneId: string,
  status: "working" | "idle" | "blocked" | "done",
) => void;

export function createWorkspaces(ctx: FakeContext) {
  const { root, snapshot, outputs, revisions, findPane, broadcast } = ctx;

  // done は観測側の既読でだけ idle になる状態。hwc からは作れないので、E2E の
  // フィクスチャだけが直接作れるようにする（終了時刻の表示を確かめるため）。
  const setAgentStatus = (paneId: string, status: "working" | "idle" | "blocked" | "done") => {
    const pane = findPane(paneId);
    if (pane === null) return;
    pane.agent_status = status;
    const tab = snapshot.tabs?.find((item) => item.tab_id === pane.tab_id);
    if (tab) tab.agent_status = status;
    const workspace = snapshot.workspaces?.find((item) => item.workspace_id === pane.workspace_id);
    if (workspace) workspace.agent_status = status;
    broadcast("pane.updated", { pane_id: paneId });
  };

  // focus は 1 枚の seen を進めるだけなので、タブとスペースの集約は残りのペインから
  // 引き直す。同じ値を上書きすると、他に動いているペインがあるスペースまで idle になる。
  const STATUS_RANK: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3 };
  const aggregateStatus = (panes: readonly HerdrPane[]): HerdrTab["agent_status"] => {
    let best: HerdrTab["agent_status"] = "unknown";
    for (const pane of panes) {
      const status = pane.agent_status ?? "unknown";
      if (status === "unknown") continue;
      if (best === "unknown" || STATUS_RANK[status]! < STATUS_RANK[best]!) best = status;
    }
    return best;
  };

  const refreshAggregates = (pane: HerdrPane) => {
    const panes = snapshot.panes ?? [];
    const tab = snapshot.tabs?.find((item) => item.tab_id === pane.tab_id);
    if (tab) {
      tab.agent_status = aggregateStatus(panes.filter((item) => item.tab_id === pane.tab_id));
    }
    const workspace = snapshot.workspaces?.find((item) => item.workspace_id === pane.workspace_id);
    if (workspace) {
      workspace.agent_status = aggregateStatus(
        panes.filter((item) => item.workspace_id === pane.workspace_id),
      );
    }
  };

  const focus = (paneId: string): boolean => {
    const pane = findPane(paneId);
    if (pane === null) return false;
    snapshot.focused_pane_id = pane.pane_id;
    snapshot.focused_tab_id = pane.tab_id;
    snapshot.focused_workspace_id = pane.workspace_id;
    for (const workspace of snapshot.workspaces ?? []) {
      workspace.focused = workspace.workspace_id === pane.workspace_id;
    }
    for (const tab of snapshot.tabs ?? []) {
      tab.focused = tab.tab_id === pane.tab_id;
    }
    for (const item of snapshot.panes ?? []) {
      item.focused = item.pane_id === pane.pane_id;
    }
    return true;
  };

  const closePane = (paneId: string): boolean => {
    if (findPane(paneId) === null) return false;
    snapshot.panes = (snapshot.panes ?? []).filter((pane) => pane.pane_id !== paneId);
    snapshot.agents = (snapshot.agents ?? []).filter((agent) => agent.pane_id !== paneId);
    outputs.delete(paneId);
    revisions.delete(paneId);

    const panes = snapshot.panes ?? [];
    snapshot.tabs = (snapshot.tabs ?? []).filter((tab) =>
      panes.some((pane) => pane.tab_id === tab.tab_id),
    );
    const tabs = snapshot.tabs ?? [];
    snapshot.workspaces = (snapshot.workspaces ?? []).filter((workspace) =>
      tabs.some((tab) => tab.workspace_id === workspace.workspace_id),
    );

    if (snapshot.focused_pane_id === paneId) {
      const next = panes[0] ?? null;
      if (next === null) {
        snapshot.focused_pane_id = null;
        snapshot.focused_tab_id = null;
        snapshot.focused_workspace_id = null;
      } else {
        focus(next.pane_id);
      }
    }
    return true;
  };

  // 実 Herdr と同じく、渡された id の列をその順のまま 1 ブロックとして動かす。
  // アンカーの前に入れ、アンカーが無ければ末尾へ置く。
  const moveWorkspaceBlock = (
    workspaceIds: readonly string[],
    beforeWorkspaceId: string | null,
  ): HerdrWorkspace[] | null => {
    const all = snapshot.workspaces ?? [];
    const known = new Set(all.map((workspace) => workspace.workspace_id));
    if (workspaceIds.length === 0 || new Set(workspaceIds).size !== workspaceIds.length)
      return null;
    if (!workspaceIds.every((id) => known.has(id))) return null;
    if (
      beforeWorkspaceId !== null &&
      (!known.has(beforeWorkspaceId) || workspaceIds.includes(beforeWorkspaceId))
    ) {
      return null;
    }

    const moved = workspaceIds.map(
      (id) => all.find((workspace) => workspace.workspace_id === id) as HerdrWorkspace,
    );
    const movedIds = new Set(workspaceIds);
    const rest = all.filter((workspace) => !movedIds.has(workspace.workspace_id));
    const at =
      beforeWorkspaceId === null
        ? rest.length
        : rest.findIndex((workspace) => workspace.workspace_id === beforeWorkspaceId);
    if (at < 0) return null;

    const ordered = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
    snapshot.workspaces = ordered;
    return ordered;
  };

  // 実 Herdr の worktree.remove は git worktree remove を実行し、スペースも閉じる。
  // E2E では実際のディレクトリを触らず、スナップショットからスペースを取り除く。
  const removeWorkspace = (workspaceId: string): boolean => {
    const workspace = (snapshot.workspaces ?? []).find((item) => item.workspace_id === workspaceId);
    if (workspace === undefined) return false;
    const paneIds = new Set(
      (snapshot.panes ?? [])
        .filter((pane) => pane.workspace_id === workspaceId)
        .map((pane) => pane.pane_id),
    );
    snapshot.panes = (snapshot.panes ?? []).filter((pane) => pane.workspace_id !== workspaceId);
    snapshot.agents = (snapshot.agents ?? []).filter((agent) => !paneIds.has(agent.pane_id ?? ""));
    snapshot.tabs = (snapshot.tabs ?? []).filter((tab) => tab.workspace_id !== workspaceId);
    snapshot.workspaces = (snapshot.workspaces ?? []).filter(
      (item) => item.workspace_id !== workspaceId,
    );
    for (const paneId of paneIds) {
      outputs.delete(paneId);
      revisions.delete(paneId);
    }
    if (snapshot.focused_workspace_id === workspaceId) {
      const next = (snapshot.panes ?? [])[0] ?? null;
      if (next === null) {
        snapshot.focused_pane_id = null;
        snapshot.focused_tab_id = null;
        snapshot.focused_workspace_id = null;
      } else {
        focus(next.pane_id);
      }
    }
    return true;
  };

  const removeWorktree = (workspaceId: string): boolean => {
    const workspace = (snapshot.workspaces ?? []).find((item) => item.workspace_id === workspaceId);
    if (workspace === undefined || workspace.worktree?.is_linked_worktree !== true) return false;
    return removeWorkspace(workspaceId);
  };

  // 実 Herdr の worktree.create は git worktree add を実行し、リンクされたスペースを開く。
  // E2E では架空のチェックアウトを一時ディレクトリに作り、スナップショットにスペース・タブ・
  // root pane を足す。モデル検証は root pane の cwd で走るので、ディレクトリは実在させる。
  let worktreeCount = 0;
  const createWorktree = async (
    workspaceId: string,
  ): Promise<{ workspace: HerdrWorkspace; tab: HerdrTab; rootPane: HerdrPane } | null> => {
    const source = (snapshot.workspaces ?? []).find((item) => item.workspace_id === workspaceId);
    const sourceWorktree = source?.worktree ?? null;
    if (source === undefined || sourceWorktree === null) return null;
    worktreeCount += 1;
    const number =
      Math.max(
        0,
        ...(snapshot.workspaces ?? []).map(
          (item) => Number(item.workspace_id.replace(/[^0-9]/g, "")) || 0,
        ),
      ) + 1;
    const id = `w${number}`;
    const callsign = `silver-cloud-${worktreeCount}`;
    const branch = `worktree/${callsign}`;
    const checkoutPath = join(root, "worktrees", branch.replace("/", "-"));
    await mkdir(join(checkoutPath, ".git"), { recursive: true });
    await writeFile(join(checkoutPath, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    // 実 Herdr は worktree のフォルダ名（worktree-<呼び名>）をスペース名にする。表示の
    // 省略規則を E2E でも通すため、同じ形にする。
    const workspace: HerdrWorkspace = {
      workspace_id: id,
      label: `worktree-${callsign}`,
      agent_status: "idle",
      focused: false,
      worktree: {
        repo_name: sourceWorktree.repo_name,
        repo_root: sourceWorktree.repo_root ?? null,
        checkout_path: checkoutPath,
        is_linked_worktree: true,
      },
    };
    const tab: HerdrTab = {
      tab_id: `${id}:t1`,
      workspace_id: id,
      label: "main",
      agent_status: "idle",
      focused: false,
    };
    const rootPane: HerdrPane = {
      pane_id: `${id}:p1`,
      workspace_id: id,
      tab_id: tab.tab_id,
      cwd: checkoutPath,
      label: null,
      agent_status: "unknown",
      focused: false,
      agent_session: null,
    };
    snapshot.workspaces = [...(snapshot.workspaces ?? []), workspace];
    snapshot.tabs = [...(snapshot.tabs ?? []), tab];
    snapshot.panes = [...(snapshot.panes ?? []), rootPane];
    outputs.set(rootPane.pane_id, "$ ");
    revisions.set(rootPane.pane_id, 0);
    // focus: true を送っているので、実 Herdr と同じく新しいスペースへ移る。
    focus(rootPane.pane_id);
    return { workspace, tab, rootPane };
  };

  return {
    focus,
    closePane,
    moveWorkspaceBlock,
    removeWorkspace,
    removeWorktree,
    createWorktree,
    setAgentStatus,
    refreshAggregates,
    aggregateStatus,
    STATUS_RANK,
  };
}

export type Workspaces = ReturnType<typeof createWorkspaces>;
