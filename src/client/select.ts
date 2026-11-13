import type {
  AgentStatus,
  AppState,
  PaneState,
  TabState,
  WorkspaceState,
} from "../server/herdr/state";
import type { GitSync } from "../shared/git";
import { parentPaneOf } from "../shared/parent-pane";
import type { Place } from "../shared/place";
import { placeOf } from "../shared/place";
import type { PullRequest, PullRequestState } from "../shared/pull-request";

export type PaneRow = {
  workspace: WorkspaceState;
  tab: TabState;
  pane: PaneState;
};

export function findPaneRow(state: AppState, paneId: string | null): PaneRow | null {
  if (paneId === null) return null;
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.id === paneId) return { workspace, tab, pane };
      }
    }
  }
  return null;
}

export function findPane(state: AppState, paneId: string | null): PaneState | null {
  return findPaneRow(state, paneId)?.pane ?? null;
}

export function countPanes(state: AppState): number {
  return state.workspaces.reduce(
    (total, workspace) =>
      total + workspace.tabs.reduce((tabTotal, tab) => tabTotal + tab.panes.length, 0),
    0,
  );
}

export type WorkspaceGroup = {
  key: string;
  // git 管理外のワークスペースは単独で 1 グループ。repoName があれば同じリポジトリの束。
  repoName: string | null;
  // 同じ場所を指す Herdr ネイティブのスペースを束ねているときだけ入る。
  place: Place | null;
  host: AppState["workspaces"][number] | null;
  linked: AppState["workspaces"];
};

// 同じリポジトリのワークスペースは 1 つに束ねる。本体（linked でないもの）を親に置く。
// Herdr が管理しないスペースは、同じパス・同じラベルの重複だけ場所で束ねる。それ以外は
// git から補った worktree 情報を含めて、今までどおりリポジトリ束に任せる。
export function groupWorkspaces(workspaces: readonly WorkspaceState[]): WorkspaceGroup[] {
  const groups: WorkspaceGroup[] = [];
  const byRepo = new Map<string, WorkspaceGroup>();
  const byPlace = new Map<string, WorkspaceGroup>();
  const placeCounts = new Map<string, number>();

  for (const workspace of workspaces) {
    const place = placeOf(workspace);
    if (place !== null) placeCounts.set(place.key, (placeCounts.get(place.key) ?? 0) + 1);
  }

  for (const workspace of workspaces) {
    const place = placeOf(workspace);
    if (place !== null && (placeCounts.get(place.key) ?? 0) >= 2) {
      const existing = byPlace.get(place.key);
      if (existing === undefined) {
        const group: WorkspaceGroup = {
          key: place.key,
          repoName: null,
          place,
          host: workspace,
          linked: [],
        };
        byPlace.set(place.key, group);
        groups.push(group);
      } else {
        existing.linked = [...existing.linked, workspace];
      }
      continue;
    }

    const worktree = workspace.worktree;
    if (!worktree) {
      groups.push({
        key: workspace.id,
        repoName: null,
        place: null,
        host: workspace,
        linked: [],
      });
      continue;
    }

    const existing = byRepo.get(worktree.repoName);
    if (!existing) {
      const group: WorkspaceGroup = {
        key: `repo:${worktree.repoName}`,
        repoName: worktree.repoName,
        place: null,
        host: worktree.isLinkedWorktree ? null : workspace,
        linked: worktree.isLinkedWorktree ? [workspace] : [],
      };
      byRepo.set(worktree.repoName, group);
      groups.push(group);
      continue;
    }

    if (worktree.isLinkedWorktree || existing.host) {
      existing.linked = [...existing.linked, workspace];
    } else {
      existing.host = workspace;
    }
  }

  return groups;
}

// 束のメンバーを Herdr の並びで返す。場所の束では先頭が代表になる。
export function groupMembers(group: WorkspaceGroup): WorkspaceState[] {
  return group.host === null ? group.linked : [group.host, ...group.linked];
}

// そのスペースが場所の束に入っているときだけ、束の key を返す。
export function placeGroupKeyFor(
  workspaces: readonly WorkspaceState[],
  workspaceId: string,
): string | null {
  for (const group of groupWorkspaces(workspaces)) {
    if (group.place === null) continue;
    if (groupMembers(group).some((workspace) => workspace.id === workspaceId)) return group.key;
  }
  return null;
}

// 重複したネイティブスペースだけを閉じられる。最後の 1 つは残す。
// ファイルは消さないので、linked worktree の削除とは入り口を分ける。
export function canCloseDuplicateSpace(state: AppState, workspaceId: string): boolean {
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (workspace === undefined) return false;
  const place = placeOf(workspace);
  if (place === null) return false;
  return state.workspaces.filter((item) => placeOf(item)?.key === place.key).length >= 2;
}

export function countWorkspacePanes(workspaceId: string, state: AppState): number {
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return 0;
  return workspace.tabs.reduce((total, tab) => total + tab.panes.length, 0);
}

// シェルだけの束は、状態の集約だけではエージェントの居る束と見分けられない。Herdr は
// シェルだけのスペースにも idle を返すことがあるため、見出しはペインとは別に数える。
export function countWorkspaceAgents(workspace: WorkspaceState): number {
  return workspace.tabs.reduce((total, tab) => total + countTabAgents(tab), 0);
}

export function countTabAgents(tab: TabState): number {
  return tab.panes.filter((pane) => pane.agent !== null).length;
}

// 親マークを出すペイン。エージェントが 1 枚だけのスペースは親が自明なので出さない。
export function markedParentPaneIds(state: AppState): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const workspace of state.workspaces) {
    if (countWorkspaceAgents(workspace) < 2) continue;
    const parent = parentPaneOf(workspace);
    if (parent !== null) ids.add(parent.id);
  }
  return ids;
}

// タブが 1 つだけのワークスペースでは、タブは何も束ねていない。タブ行を出さず、
// ペインを親の直下に並べるために、そのタブを返す。
export function soleTab(workspace: WorkspaceState): TabState | null {
  return workspace.tabs.length === 1 ? workspace.tabs[0] : null;
}

export type PaneContext = {
  workspaceId: string;
  workspaceLabel: string;
  // 狭い見出しに出すスペース名。前置きを落とした表示用で、フルは workspaceLabel に残す。
  workspaceName: string;
  tabLabel: string;
  // ブランチはスペースの属性。同じスペースのペインは同じ値になる。
  branch: string | null;
  sync: GitSync | null;
  // チャット見出しに出すリポジトリ名。git 管理外のスペースでは null。
  repoName: string | null;
};

// 画面上部に出す、いま見ている対象の要約。選択が無いときは null。
export function findPaneContext(state: AppState, paneId: string | null): PaneContext | null {
  const row = findPaneRow(state, paneId);
  if (row === null) return null;
  return {
    workspaceId: row.workspace.id,
    workspaceLabel: row.workspace.label,
    workspaceName: shortenSpaceName(row.workspace),
    tabLabel: row.tab.label,
    branch: row.workspace.branch ?? null,
    sync: row.workspace.sync ?? null,
    repoName: row.workspace.worktree?.repoName ?? null,
  };
}

// 端末タイトルの先頭にはエージェント自身の印が付く（`π - hwc` / `OC | title`）。
// Provider は詳細のアイコンで分かるので、名前からは印を落とす。形が違えばそのまま使う。
function titleText(title: string | null): string | null {
  if (title === null) return null;
  const text = title
    .replace(/^π\s*-\s*/, "")
    .replace(/^OC\s*\|\s*/i, "")
    .trim();
  return text === "" ? null : text;
}

// 一覧・タブ・見出しで同じ名前を出す。label は Herdr で付けた作業名、title は端末のタイトル。
// 端末タイトルは同じリポジトリのペインで同じ値になるので、ラベルがあればそちらを主にする。
// エージェントのいないペインはシェル。ID は詳細ヘッダと読み上げに任せ、名前には出さない。
export function paneName(pane: PaneState): string {
  return pane.label ?? titleText(pane.title) ?? pane.agent ?? "シェル";
}

// 一覧の 1 段目はペイン名。端末タイトルは同じリポジトリで同じ値になるので、
// 名前が無いペインだけエージェント種別、それも無ければタイトルに倒す。
export function paneRowTitle(pane: PaneState): string {
  return pane.label ?? pane.agent ?? paneName(pane);
}

// Herdr が linked worktree に付ける `worktree-` は、ワークツリーであることを示すだけで、
// その役目は一覧の記号とリポジトリの束が持つ。狭いタブやセルでは前置きに幅を食われて
// 呼び名が隠れるので、表示だけ落とす。TUI と照合するフルは title と aria に残す。
const WORKTREE_PREFIX = "worktree-";

// ブランチも Herdr の linked worktree では `worktree/<name>` になる。スペース名と同じく
// 表示だけ落とし、PR の取得やメニューに使うフルは変えない。
const WORKTREE_BRANCH_PREFIX = "worktree/";

export function shortenSpaceName(workspace: WorkspaceState): string {
  const label = workspace.label;
  if (workspace.worktree?.isLinkedWorktree !== true || !label.startsWith(WORKTREE_PREFIX)) {
    return label;
  }
  const rest = label.slice(WORKTREE_PREFIX.length);
  return rest === "" ? label : rest;
}

export function shortenBranchName(workspace: WorkspaceState, branch: string): string {
  if (workspace.worktree?.isLinkedWorktree !== true) return branch;
  if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) return branch;
  const rest = branch.slice(WORKTREE_BRANCH_PREFIX.length);
  return rest === "" ? branch : rest;
}

// 名前の無いペインの端末タイトルはワークツリー名そのものになる。狭いタブやセルでは 2 段目や
// チップのスペース名と同じ文字列になるので、同じ省略形に揃える。別名のペインはそのまま。
export function shortenPaneName(
  name: string,
  workspaceLabel: string,
  workspaceName: string,
): string {
  return name === workspaceLabel ? workspaceName : name;
}

export function tabDisplayName(name: string, workspace: WorkspaceState): string {
  return shortenPaneName(name, workspace.label, shortenSpaceName(workspace));
}

// 名前の区切り。帯が場所を言うので、行の名前からは場所の部分と一緒に落とす。
const SEPARATOR = /[\s._/·:-]/;
const LEADING_SEPARATORS = /^[\s._/·:-]+/;
const TRAILING_SEPARATORS = /[\s._/·:-]+$/;

// アクティブの行は帯がワークスペース名を持つ。行で同じ名前を繰り返すと、識別に使える幅が
// 減る。区切りを挟んで始まる / 終わるときだけ落とし、残りが空なら元のラベルを使う。
// 区切りを要求するのは、同じ文字で始まるだけの別の名前を短くしないため。
export function activeRowName(workspaceLabel: string, name: string): string {
  const label = workspaceLabel.trim();
  if (label === "" || name.length <= label.length) return name;
  const lower = name.toLowerCase();
  const target = label.toLowerCase();
  if (lower.startsWith(target) && SEPARATOR.test(name.charAt(label.length))) {
    const rest = name.slice(label.length).replace(LEADING_SEPARATORS, "");
    if (rest !== "") return rest;
  }
  const before = name.charAt(name.length - label.length - 1);
  if (lower.endsWith(target) && SEPARATOR.test(before)) {
    const rest = name.slice(0, name.length - label.length).replace(TRAILING_SEPARATORS, "");
    if (rest !== "") return rest;
  }
  return name;
}

// メニューに出すときは末尾を残す。パスは末尾で場所を見分けるので、先頭を削る。
// コピーする値は省略しない。
export function shortenPath(path: string, max = 36): string {
  const chars = Array.from(path);
  if (chars.length <= max) return path;
  const tail = chars.slice(-(max - 1)).join("");
  const boundary = tail.indexOf("/");
  return `…${boundary < 0 ? tail : tail.slice(boundary)}`;
}

export type StatusTone = "active" | "attention" | "success" | "neutral";

export function statusTone(status: AgentStatus): StatusTone {
  switch (status) {
    case "working":
      return "active";
    case "blocked":
      return "attention";
    case "done":
      return "success";
    default:
      return "neutral";
  }
}

export type PullRequestTone = "open" | "merged";

// 一覧のチップは open と merged にだけ出す。closed は作業の現在地でも終わりでもないので、
// 今までどおり何も出さない。
export function pullRequestTone(state: PullRequestState): PullRequestTone | null {
  switch (state) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    default:
      return null;
  }
}

// 記号だけでは状態が伝わらない読み上げのために、merged のときだけ言葉を添える。
export function pullRequestLabel(pullRequest: PullRequest): string {
  return pullRequest.state === "MERGED"
    ? `PR #${pullRequest.number}（マージ済み）を GitHub で開く`
    : `PR #${pullRequest.number} を GitHub で開く`;
}

export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "working":
      return "実行中";
    case "blocked":
      return "要対応";
    case "done":
      return "完了";
    case "idle":
      return "待機";
    default:
      return "不明";
  }
}

// 畳んだ場所の束では、代表 1 つの状態だけを出すと、もう片方の要対応や実行中が
// 見えなくなる。行動が必要な順に最も強い状態を 1 つ選ぶ。
const URGENT_STATUSES: readonly AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];

export function mostUrgentStatus(statuses: readonly AgentStatus[]): AgentStatus {
  for (const status of URGENT_STATUSES) {
    if (statuses.includes(status)) return status;
  }
  return "unknown";
}

// フォーカス中の workspace だけを開いた状態で始める。
// 開いた状態はワークスペースとタブの id を同じ集合で持つ。id は階層をまたいで重ならない。
export function initialExpanded(state: AppState): Set<string> {
  const open = new Set(
    state.workspaces.filter((workspace) => workspace.focused).map((workspace) => workspace.id),
  );
  for (const workspace of state.workspaces) {
    // 同じリポジトリのワークツリーを束ねている行も開いておく。
    if (workspace.worktree) open.add(`repo:${workspace.worktree.repoName}`);
    for (const tab of workspace.tabs) {
      if (tab.focused) open.add(tab.id);
    }
  }
  // 場所の束は既定で畳む。重複を 1 行にまとめることが目的なので、フォーカスが
  // 中にあるときだけ開く。自分で開閉した記憶は applyOpenGroups が上書きする。
  for (const group of groupWorkspaces(state.workspaces)) {
    if (group.place === null) continue;
    if (groupMembers(group).some((workspace) => workspace.focused)) open.add(group.key);
  }
  return open;
}

// 一覧に出ている開閉できる単位（ワークスペース・タブ・リポジトリ束・場所の束）。
export function groupIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  for (const workspace of state.workspaces) {
    ids.add(workspace.id);
    if (workspace.worktree) ids.add(`repo:${workspace.worktree.repoName}`);
    for (const tab of workspace.tabs) ids.add(tab.id);
  }
  for (const group of groupWorkspaces(state.workspaces)) {
    if (group.place !== null) ids.add(group.key);
  }
  return ids;
}

export type AgentGlyph = "pi" | "claude" | "codex" | "opencode" | "generic";

// Herdr は端末だけのペインにエージェントを割り当てない。入力の形を選ぶのに使う。
export function isShellPane(pane: PaneState): boolean {
  return pane.agent === null;
}

// 一覧のアイコンを決める。opencode は "pi" を含まないが、順序に依存しないよう先に見る。
export function agentGlyph(agent: string | null): AgentGlyph {
  const name = (agent ?? "").toLowerCase();
  if (name.includes("opencode")) return "opencode";
  if (name.includes("claude") || name.includes("anthropic")) return "claude";
  if (name.includes("codex") || name.includes("openai") || name.includes("gpt")) return "codex";
  if (
    name === "pi" ||
    name.startsWith("pi-") ||
    name.startsWith("pi ") ||
    name.includes("coding-agent")
  ) {
    return "pi";
  }
  return "generic";
}
