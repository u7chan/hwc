import type { PaneState } from "../../server/herdr/state";
import type { PullRequest } from "../../shared/pull-request";
import { ArrowRightIcon, GitHubIcon, MergeIcon, MoreIcon, PaneIcon } from "../icons";
import { GitCount } from "../GitCount";
import { MENU_ID } from "../Menu";
import { ParentMark } from "../ParentMark";
import { showsTabName, type ActiveGroup, type ActiveStatus } from "../scope";
import {
  activeRowName,
  paneRowTitle,
  pullRequestLabel,
  pullRequestTone,
  shortenBranchName,
  statusLabel,
  statusTone,
} from "../select";
import { StatusIcon } from "../StatusLabel";
import { finishedClock, formatElapsed, workingMs } from "../time";
import { WorkspaceGlyph } from "./groups";
import type { PaneListProps } from "./types";

export function NoPanes() {
  return (
    <div class="hwc-empty">
      <div class="hwc-empty-mark">
        <PaneIcon size={32} />
      </div>
      <h2 class="hwc-empty-title">ペインがありません</h2>
      <p class="hwc-empty-text">Herdr でワークスペースとペインを開くと、ここに一覧が出ます。</p>
    </div>
  );
}

// 右端は「あとどれだけ待つか」と「いつ終わったか」。要対応だけは時刻ではなく言葉で示す。
function ActiveTrail(props: {
  pane: PaneState;
  workingSince: ReadonlyMap<string, number>;
  finishedAt: ReadonlyMap<string, number>;
  now: number;
}) {
  if (props.pane.agentStatus === "blocked") {
    return <span class="hwc-active-flag">要対応</span>;
  }
  if (props.pane.agentStatus === "working") {
    const ms = workingMs(props.workingSince, props.pane.id, props.now);
    return ms === null ? null : (
      <span class="hwc-pane-elapsed" data-tone="active">
        {formatElapsed(ms)}
      </span>
    );
  }
  const clock = finishedClock(props.finishedAt, props.pane.id);
  return clock === null ? null : (
    <span
      class="hwc-pane-elapsed"
      data-tone={props.pane.agentStatus === "done" ? "success" : undefined}
    >
      {clock}
    </span>
  );
}

const COUNT_STATUSES: readonly ActiveStatus[] = ["blocked", "done", "working"];

function ActiveCount(props: { status: ActiveStatus; count: number }) {
  if (props.count === 0) return null;
  const label = `${statusLabel(props.status)} ${props.count} 件`;
  return (
    <span class="hwc-active-count" data-tone={statusTone(props.status)} aria-label={label}>
      <span aria-hidden="true">
        <StatusIcon status={props.status} />
      </span>
      <span aria-hidden="true">{props.count}</span>
    </span>
  );
}

// 帯は場所。行はペイン。同じワークツリーの行を束ね、スクロール中も場所を見失わないよう
// 上端に貼り付ける。状態の件数は束全体の量で、行の右端はそのペインの時刻。
// 場所の記号は行の親を示す目印にする。子の段はこのアイコンの中心から線でつなぐ。
// 帯は「すべて」のその場所へ移る入口だが、`すべて` へ移れるのは右端の矢印だけにする。帯の大半は
// 読むための面なので、触れただけで移ると誤操作になる。ツリーの行末は同じ向きのシェブロンで
// 開閉するため、同じ記号にするとどちらも「進む／開く」に見えて意味が重なる。
function ActiveBand(props: {
  group: ActiveGroup;
  pullRequest: PullRequest | null;
  onOpen: () => void;
  onWorkspaceMenu: (trigger: HTMLElement) => void;
  menuOpen: boolean;
}) {
  const { workspace, counts } = props.group;
  const branch = workspace.branch ?? null;
  const branchLabel = branch === null ? null : shortenBranchName(workspace, branch);
  // 帯の 2 段目は場所の所属とブランチ。見出しが PR タイトルになるため、リポジトリは
  // ここでしか読めない。狭いときはブランチ側を先に省き、リポジトリ名を残す。
  const repoName = workspace.worktree?.repoName ?? null;
  const pullRequest = props.pullRequest;
  const sync = workspace.sync ?? null;
  // GitHub のリモートがあるかは、リポジトリ名の左の記号で示す。ローカルのみの
  // リポジトリと非 git は記号を持たない（ADR 0083）。
  const hasGitHubRemote = sync?.repoUrl != null;
  // ワークツリー名はランダムで、タスクを思い出す手がかりにならない。PR があれば
  // タイトルを先頭に置き、名前は矢印の読み上げとツリーに残す。
  const heading = pullRequest?.title ?? workspace.label;
  const pullRequestState = pullRequest === null ? null : pullRequestTone(pullRequest.state);
  // 件数は最後の行の右端に置く。タイトルの幅を件数に削らせない。
  const countsNode = (
    <span class="hwc-active-band-counts">
      {COUNT_STATUSES.map((status) => (
        <ActiveCount key={status} status={status} count={counts[status]} />
      ))}
    </span>
  );
  return (
    <div class="hwc-active-band">
      <button
        type="button"
        class="hwc-space-icon"
        aria-label={`${workspace.label} のメニュー`}
        aria-haspopup="menu"
        aria-expanded={props.menuOpen}
        aria-controls={MENU_ID}
        data-open={props.menuOpen}
        onClick={(event) => props.onWorkspaceMenu(event.currentTarget)}
      >
        <span class="hwc-active-band-icon">
          <WorkspaceGlyph worktree={workspace.worktree} />
        </span>
      </button>
      <div class="hwc-active-band-main">
        <div class="hwc-active-band-title">
          <h2 class="hwc-active-band-name" id={bandId(workspace.id)} title={heading}>
            {heading}
          </h2>
          {pullRequest === null || pullRequestState === null ? null : (
            <a
              class="hwc-active-band-pr"
              data-state={pullRequestState}
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              aria-label={pullRequestLabel(pullRequest)}
            >
              {pullRequestState === "merged" ? <MergeIcon size={13} /> : null}#{pullRequest.number}
            </a>
          )}
        </div>
        {branch === null ? null : (
          <p class="hwc-active-band-line">
            <span class="hwc-active-band-place">
              {repoName === null ? null : (
                <span class="hwc-active-band-repo-group">
                  {hasGitHubRemote ? (
                    <span
                      class="hwc-active-band-remote"
                      role="img"
                      aria-label="GitHub リモートあり"
                      title="GitHub リモートあり"
                    >
                      <GitHubIcon size={13} />
                    </span>
                  ) : null}
                  <span class="hwc-active-band-repo" title={repoName}>
                    {repoName}
                  </span>
                </span>
              )}
              <span class="hwc-active-band-branch" title={branch}>
                {branchLabel}
              </span>
            </span>
            <GitCount sync={sync} />
            {countsNode}
          </p>
        )}
      </div>
      {branch === null ? countsNode : null}
      <button
        type="button"
        class="hwc-active-band-jump"
        aria-label={`${workspace.label} をすべての一覧で開く`}
        title={branch === null ? workspace.label : `${workspace.label} · ${branch}`}
        onClick={props.onOpen}
      >
        <ArrowRightIcon />
      </button>
    </div>
  );
}

function bandId(workspaceId: string): string {
  return `hwc-active-band-${workspaceId}`;
}

// ツリーでそのスペースの見出し（メニューの入口）まで送るための目印。
export function spaceId(workspaceId: string): string {
  return `hwc-space-${workspaceId}`;
}

// ワークスペース（ワークツリー）ごとに束ねた行を並べる（activeGroups）。
// 開いた時点では既読を送らない。
export function ActivePaneList(props: PaneListProps & { groups: readonly ActiveGroup[] }) {
  const { groups } = props;
  if (groups.length === 0) {
    return (
      <div class="hwc-list-note">
        <p class="hwc-list-note-title">エージェントがいません</p>
        <p class="hwc-list-note-text">
          起動しているエージェントのペインが、待機中も含めてここに並びます。シェルだけのスペースは「すべて」に出ます。
        </p>
      </div>
    );
  }

  return (
    <div class="hwc-active">
      {groups.map((group) => (
        <section
          key={group.workspace.id}
          class="hwc-active-group"
          aria-labelledby={bandId(group.workspace.id)}
          data-removal={
            props.removal?.workspaceId === group.workspace.id ? props.removal.phase : undefined
          }
        >
          <ActiveBand
            group={group}
            pullRequest={props.pullRequests.get(group.workspace.id) ?? null}
            onOpen={() => props.onRevealWorkspace(group.workspace.id)}
            onWorkspaceMenu={(trigger) => props.onWorkspaceMenu(group.workspace.id, trigger)}
            menuOpen={props.openWorkspaceMenuId === group.workspace.id}
          />
          <ul class="hwc-active-rows">
            {group.rows.map(({ tab, pane }) => {
              const current = pane.id === props.selectedPaneId;
              const slot = props.slots.indexOf(pane.id);
              const name = paneRowTitle(pane);
              return (
                <li key={pane.id} class="hwc-active-row">
                  <div
                    class="hwc-active-pane"
                    data-current={current}
                    data-slot={slot >= 0 ? slot + 1 : undefined}
                  >
                    <button
                      type="button"
                      class="hwc-active-open"
                      aria-current={current ? "true" : undefined}
                      onPointerDown={(event) => props.onDragStart(event, pane.id)}
                      onClick={() => props.onOpen(pane.id)}
                    >
                      <StatusIcon status={pane.agentStatus} />
                      <span class="hwc-active-main">
                        <span class="hwc-active-title">
                          <span class="hwc-active-name" title={name}>
                            {activeRowName(group.workspace.label, name)}
                          </span>
                          {props.parentPaneIds.has(pane.id) ? <ParentMark /> : null}
                        </span>
                        {showsTabName(group.workspace) ? (
                          <span class="hwc-active-tab">· {tab.label}</span>
                        ) : null}
                      </span>
                      <ActiveTrail
                        pane={pane}
                        workingSince={props.workingSince}
                        finishedAt={props.finishedAt}
                        now={props.now}
                      />
                    </button>
                    <button
                      type="button"
                      class="hwc-pane-more"
                      aria-label={`${name} のメニュー`}
                      aria-haspopup="menu"
                      aria-expanded={props.openPaneMenuId === pane.id}
                      aria-controls={MENU_ID}
                      onClick={(event) => props.onPaneMenu(pane.id, event.currentTarget)}
                    >
                      <MoreIcon />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
