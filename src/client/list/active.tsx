import type { PaneState, WorkspaceState } from "../../server/herdr/state";
import type { PullRequest } from "../../shared/pull-request";
import { useLayoutEffect, useRef } from "preact/hooks";
import { DragGhost } from "../DragGhost";
import {
  AgentGlyphIcon,
  AgentIcon,
  ArrowRightIcon,
  GitHubIcon,
  MergeIcon,
  MoreIcon,
  PaneIcon,
} from "../icons";
import { GitCount } from "../GitCount";
import { MENU_ID } from "../Menu";
import { isOrderChange, reorderKeys } from "../order";
import { useOrderDrag, useOrderDropGuide } from "../order-drag";
import { ParentMark } from "../ParentMark";
import { showsTabName, type ActiveGroup, type ActiveStatus } from "../scope";
import {
  agentGlyph,
  paneDisplayName,
  pullRequestLabel,
  pullRequestTone,
  shortenBranchName,
  shortenPaneName,
  statusLabel,
  statusTone,
} from "../select";
import { StatusIcon } from "../StatusLabel";
import { finishedClock, formatElapsed, workingMs } from "../time";
import { WorkspaceGlyph } from "./groups";
import type { ListFeedback, PaneListProps } from "./types";

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

type BandDragProps = {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
  onLostPointerCapture: (event: PointerEvent) => void;
  onClickCapture: (event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
};

// 帯の見出し。PR があればタイトルを先頭に置き、名前は矢印の読み上げとツリーに残す。
function bandHeading(workspace: WorkspaceState, pullRequest: PullRequest | null): string {
  return pullRequest?.title ?? workspace.label;
}

// 帯は場所。行はペイン。同じワークツリーの行を束ね、スクロール中も場所を見失わないよう
// 上端に貼り付ける。状態の件数は束全体の量で、行の右端はそのペインの時刻。
// 場所の記号は行の親を示す目印にする。子の段はこのアイコンの中心から線でつなぐ。
// 帯は「すべて」のその場所へ移る入口だが、`すべて` へ移れるのは右端の矢印だけにする。帯の大半は
// 読むための面なので、触れただけで移ると誤操作になる。ツリーの行末は同じ向きのシェブロンで
// 開閉するため、同じ記号にするとどちらも「進む／開く」に見えて意味が重なる。
// 帯の見出しは掴んで動かす面。行（ペイン）は開く面なので、ドラッグの対象にしない。
function ActiveBand(props: {
  group: ActiveGroup;
  pullRequest: PullRequest | null;
  onOpen: () => void;
  onWorkspaceMenu: (trigger: HTMLElement) => void;
  menuOpen: boolean;
  dragProps: BandDragProps;
}) {
  const { workspace, counts } = props.group;
  const branch = workspace.branch ?? null;
  const branchLabel = branch === null ? null : shortenBranchName(workspace, branch);
  // 帯の 2 段目は場所の所属とブランチ。見出しが PR タイトルになるため、リポジトリは
  // ここでしか読めない。狭いときはブランチ側を先に省き、リポジトリ名を残す。
  const repoName = workspace.worktree?.repoName ?? null;
  const pullRequest = props.pullRequest;
  const sync = workspace.sync ?? null;
  // GitHub のリモートがあるときは、記号とリポジトリ名をまとめてリポジトリのリンクに
  // する。リンクにできないローカルのみのリポジトリと非 git は名前だけを出す。
  // リンクの読み上げが GitHub を名乗るため、記号は印にしない。
  const repoUrl = sync?.repoUrl ?? null;
  // ワークツリー名はランダムで、タスクを思い出す手がかりにならない。PR があれば
  // タイトルを先頭に置き、名前は矢印の読み上げとツリーに残す。
  const heading = bandHeading(workspace, pullRequest);
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
      <div class="hwc-active-band-main" {...props.dragProps}>
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
              {repoName === null ? null : repoUrl === null ? (
                <span class="hwc-active-band-repo-group">
                  <span class="hwc-active-band-repo" title={repoName}>
                    {repoName}
                  </span>
                </span>
              ) : (
                <a
                  class="hwc-active-band-repo-link"
                  href={repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${repoName} を GitHub で開く`}
                  title={repoName}
                >
                  <span class="hwc-active-band-remote" aria-hidden="true">
                    <GitHubIcon size={13} />
                  </span>
                  <span class="hwc-active-band-repo">{repoName}</span>
                </a>
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
// 開いた時点では既読を送らない。帯の順はドラッグで変えられ、BFF が持つので全端末で揃う。
export function ActivePaneList(
  props: PaneListProps & ListFeedback & { groups: readonly ActiveGroup[] },
) {
  const { groups, onNotice, onAnnounce } = props;
  const headingOf = (group: ActiveGroup): string =>
    bandHeading(group.workspace, props.pullRequests.get(group.workspace.id) ?? null);
  const units = groups.map((group) => ({
    key: group.workspace.id,
    label: headingOf(group),
  }));
  const orderKey = units.map((unit) => unit.key).join("\n");

  // 状態が新しい順で描かれる前の位置。落とした後の入れ替えを滑らせて見せる。
  const pending = useRef<{
    order: string;
    liftedKey: string;
    offsets: ReadonlyMap<string, number>;
  } | null>(null);
  const moving = useRef(false);

  const commit = (key: string, beforeKey: string | null, offsets: ReadonlyMap<string, number>) => {
    if (moving.current || !isOrderChange(units, key, beforeKey)) return;
    const keys = units.map((unit) => unit.key);
    const next = reorderKeys(keys, key, beforeKey);
    const label = units.find((unit) => unit.key === key)?.label ?? key;

    pending.current = { order: orderKey, liftedKey: key, offsets };
    moving.current = true;
    onNotice(null);
    void props.onReorderActive(next).then(
      (ok) => {
        if (ok) onAnnounce(`${label} を ${next.indexOf(key) + 1} 番目に移動しました`);
        else {
          pending.current = null;
          onNotice("並べ替えを保存できませんでした。");
        }
        moving.current = false;
      },
      () => {
        pending.current = null;
        onNotice("並べ替えを保存できませんでした。");
        moving.current = false;
      },
    );
  };

  const orderDrag = useOrderDrag({
    units,
    onDrop: (drop) => commit(drop.key, drop.beforeKey, drop.offsets),
  });
  const drag = orderDrag.drag;
  const guide = useOrderDropGuide({ units, drag, orderKey });

  // 新しい並びで描き直された直後、落とす前の位置との差分を transform で戻す。
  // 位置は offsetTop なのでスクロール位置に影響されない。
  useLayoutEffect(() => {
    const pendingMove = pending.current;
    if (pendingMove === null || pendingMove.order === orderKey) return;
    pending.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const node of document.querySelectorAll<HTMLElement>("[data-order-key]")) {
      const key = node.dataset.orderKey;
      if (key === undefined) continue;
      const before = pendingMove.offsets.get(key);
      if (before === undefined) continue;
      const delta = before - node.offsetTop;
      if (Math.abs(delta) < 1 || typeof node.animate !== "function") continue;

      const lifted = key === pendingMove.liftedKey;
      node.style.position = "relative";
      node.style.zIndex = lifted ? "2" : "1";
      if (lifted) node.dataset.reorderLifted = "true";
      const cleanup = () => {
        node.style.position = "";
        node.style.zIndex = "";
        delete node.dataset.reorderLifted;
      };
      const animation = node.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
      animation.onfinish = cleanup;
      animation.oncancel = cleanup;
    }
  });

  // リンクは押せるままにする。帯の見出しのうち、リンク以外を掴んだときだけ動かす。
  const dragPropsFor = (key: string, label: string): BandDragProps => {
    const start = orderDrag.begin(key, label);
    return {
      onPointerDown: (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("a") !== null) return;
        start(event);
      },
      onPointerMove: orderDrag.move,
      onPointerUp: orderDrag.up,
      onPointerCancel: orderDrag.cancel,
      onLostPointerCapture: orderDrag.lostCapture,
      onClickCapture: orderDrag.clickCapture,
      onContextMenu: orderDrag.contextMenu,
    };
  };

  if (groups.length === 0) {
    return (
      <div class="hwc-list-note">
        <div class="hwc-list-note-mark">
          <AgentIcon size={22} />
        </div>
        <p class="hwc-list-note-title">エージェントがいません</p>
        <p class="hwc-list-note-text">待機中も含め、起動中のエージェントがここに並びます。</p>
        <p class="hwc-list-note-text">シェルだけのスペースは「すべて」で見られます。</p>
      </div>
    );
  }

  return (
    <div class="hwc-active">
      {groups.map((group) => (
        <section
          key={group.workspace.id}
          class="hwc-active-group"
          // 並べ替えの目印。落とし先の判定と、落とす前の位置を控えるのに使う。
          data-order-key={group.workspace.id}
          data-dragging={drag?.key === group.workspace.id ? "true" : undefined}
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
            dragProps={dragPropsFor(group.workspace.id, headingOf(group))}
          />
          <ul class="hwc-active-rows">
            {group.rows.map(({ tab, pane }) => {
              const current = pane.id === props.selectedPaneId;
              const name = paneDisplayName(pane);
              return (
                <li key={pane.id} class="hwc-active-row" data-pane-id={pane.id}>
                  <div class="hwc-active-pane" data-current={current}>
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
                          <span class="hwc-pane-agent" data-agent={agentGlyph(pane.agent)}>
                            <AgentGlyphIcon agent={pane.agent} size={14} />
                          </span>
                          <span class="hwc-active-name" title={name}>
                            {shortenPaneName(name, group.workspace)}
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
      {guide === null ? null : (
        <>
          <div class="hwc-order-drop" style={{ top: `${guide.top}px` }} aria-hidden="true" />
          <span class="hwc-order-drop-label" style={{ top: `${guide.top}px` }} aria-hidden="true">
            ここに移動
          </span>
        </>
      )}
      {drag === null ? null : <DragGhost label={drag.label} />}
    </div>
  );
}
