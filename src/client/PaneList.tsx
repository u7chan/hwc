import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AppState, PaneState, TabState, WorktreeState } from "../server/herdr/state";
import type { GitSync } from "../shared/git";
import type { PullRequest } from "../shared/pull-request";
import {
  AgentGlyphIcon,
  AgentIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  GripIcon,
  MergeIcon,
  MoreIcon,
  PaneIcon,
  RepoIcon,
  WorkspaceIcon,
  WorktreeIcon,
} from "./icons";
import {
  activeRowName,
  agentGlyph,
  countPanes,
  countTabAgents,
  countWorkspaceAgents,
  countWorkspacePanes,
  groupMembers,
  groupWorkspaces,
  mostUrgentStatus,
  paneRowTitle,
  pullRequestLabel,
  pullRequestTone,
  soleTab,
  statusLabel,
  statusTone,
  type WorkspaceGroup,
} from "./select";
import {
  activeGroups,
  agentPresence,
  countLabel,
  showsTabName,
  type ActiveGroup,
  type ActiveStatus,
  type ListScope,
} from "./scope";
import { GitCount } from "./GitCount";
import { MENU_ID } from "./Menu";
import { ParentMark } from "./ParentMark";
import {
  adjacentBeforeKey,
  dropBeforeId,
  isOrderChange,
  orderUnits,
  type OrderUnit,
} from "./order";
import { useOrderDrag } from "./order-drag";
import { StatusIcon, StatusLabel } from "./StatusLabel";
import { finishedClock, formatElapsed, workingMs } from "./time";

type PaneListProps = {
  state: AppState;
  selectedPaneId: string | null;
  // 現在ペインが入っているスロット（1 始まり）。ツリーとアクティブの現在行を slot 色にする。
  currentSlot: number | null;
  parentPaneIds: ReadonlySet<string>;
  scope: ListScope;
  onScope: (scope: ListScope) => void;
  expanded: ReadonlySet<string>;
  onSelect: (paneId: string) => void;
  onOpen: (paneId: string) => void;
  // 帯から「すべて」のその場所へ移る。スコープの切り替えは PaneList が先に行う。
  onRevealWorkspace: (workspaceId: string) => void;
  reveal: { workspaceId: string; token: number } | null;
  onToggle: (groupId: string) => void;
  openPaneMenuId: string | null;
  openWorkspaceMenuId: string | null;
  onPaneMenu: (paneId: string, trigger: HTMLElement) => void;
  onWorkspaceMenu: (workspaceId: string, trigger: HTMLElement) => void;
  // 削除の対象。leave になったら一覧から行を消すアニメーションを見せ、終わったら
  // onRemovalFinished を呼ぶ。スナップショットは App がその間だけ保留している。
  removal: {
    workspaceId: string;
    phase: "confirm" | "busy" | "failed" | "leave";
  } | null;
  onRemovalFinished: () => void;
  // 一覧の束を Herdr のワークスペース順で動かす。成功したら true。
  onMoveWorkspaces: (
    workspaceIds: readonly string[],
    beforeWorkspaceId: string | null,
  ) => Promise<boolean>;
  workingSince: ReadonlyMap<string, number>;
  finishedAt: ReadonlyMap<string, number>;
  pullRequests: ReadonlyMap<string, PullRequest | null>;
  now: number;
};

type TreePaneListProps = Omit<PaneListProps, "scope" | "onScope" | "onOpen">;

// git 管理下でない / 通常のリポジトリ / linked worktree を形で見分ける。
function WorkspaceGlyph({ worktree }: { worktree: WorktreeState | null }) {
  if (!worktree) return <WorkspaceIcon />;
  return worktree.isLinkedWorktree ? <WorktreeIcon /> : <RepoIcon />;
}

function GroupChildren(props: { id: string; open: boolean; children: ComponentChildren }) {
  return (
    <div id={props.id} class="hwc-group-children" data-open={props.open}>
      <div class="hwc-children-inner">{props.children}</div>
    </div>
  );
}

// 折りたたみの状態は、開いている間は子の状態で分かるので、まとめは淡く消して場所だけ残す。
// エージェントの居ない束は状態の集約が意味を持たない（待機や不明はシェルだけでも出る）ので、
// 状態の代わりにシェルの記号を置き、エージェントの有無を右端でも読めるようにする。
function GroupStatus(props: { status: PaneState["agentStatus"]; agents: number; hidden: boolean }) {
  return (
    <span class="hwc-group-status" data-hidden={props.hidden}>
      {props.agents === 0 ? (
        <span class="hwc-group-shell" role="img" aria-label="シェルのみ" title="シェルのみ">
          <PaneIcon />
        </span>
      ) : (
        <StatusLabel status={props.status} />
      )}
    </span>
  );
}

// エージェントの数の札。副題が PR のタイトルに変わっても消えないよう、名前の行に置く。
// 数は status の件数ではなく、エージェントの居るペインの数。
function GroupAgents(props: { agents: number }) {
  return (
    <span
      class="hwc-group-agents"
      role="img"
      aria-label={agentPresence(props.agents)}
      title={agentPresence(props.agents)}
    >
      <AgentIcon size={12} />
      <span aria-hidden="true">{countLabel(props.agents)}</span>
    </span>
  );
}

// 同じ場所を指すスペースを束ねていることを、名前の横の数で示す。畳んだ状態でも
// 1 行の裏に複数の実体があることを見落とさないための札。
function GroupSpaces(props: { spaces: number }) {
  const label = `${props.spaces} スペース`;
  return (
    <span class="hwc-group-spaces" role="img" aria-label={label} title={label}>
      <WorkspaceIcon size={12} />
      <span aria-hidden="true">{countLabel(props.spaces)}</span>
    </span>
  );
}

// 既定を先頭に置く。既定が「すべて」なので、開いたときにつまみが左にいる。
const SCOPE_OPTIONS: readonly { scope: ListScope; label: string }[] = [
  { scope: "all", label: "すべて" },
  { scope: "active", label: "アクティブ" },
];

function ScopeBar(props: { scope: ListScope; count: number; onScope: (scope: ListScope) => void }) {
  return (
    <div class="hwc-scope" role="group" aria-label="一覧の絞り込み" data-scope={props.scope}>
      <span class="hwc-scope-thumb" aria-hidden="true" />
      {SCOPE_OPTIONS.map((option) => {
        // 件数はアクティブ一覧の帯（スペース）の数。行数ではない。0 のときは何も出さない。
        const count = option.scope === "active" ? props.count : 0;
        return (
          <button
            key={option.scope}
            type="button"
            class="hwc-scope-option"
            aria-pressed={props.scope === option.scope}
            aria-label={count > 0 ? `${option.label}、${count} スペース` : undefined}
            onClick={() => props.onScope(option.scope)}
          >
            {option.label}
            {count > 0 && (
              <span class="hwc-scope-count" aria-hidden="true">
                {countLabel(count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function NoPanes() {
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

// 帯に出す件数。状態の意味（要対応 → 完了 → 実行中）の順に並べる。0 件は出さない。
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
// 帯全体は「すべて」のその場所へ移る入口。中身の上に透明なボタンを重ねる。
// その移動は矢印で示す。ツリーの行末は同じ向きのシェブロンで開閉するため、同じ記号にすると
// どちらも「進む／開く」に見えて意味が重なる。
function ActiveBand(props: {
  group: ActiveGroup;
  pullRequest: PullRequest | null;
  onOpen: () => void;
  onWorkspaceMenu: (trigger: HTMLElement) => void;
  menuOpen: boolean;
}) {
  const { workspace, counts } = props.group;
  const branch = workspace.branch ?? null;
  const pullRequest = props.pullRequest;
  const sync = workspace.sync ?? null;
  // ワークツリー名はランダムで、タスクを思い出す手がかりにならない。PR があれば
  // タイトルを先頭に置き、名前は帯全体のボタンの読み上げとツリーに残す。
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
            <span class="hwc-active-band-branch" title={branch}>
              {branch}
            </span>
            <GitCount sync={sync} />
            {countsNode}
          </p>
        )}
      </div>
      {branch === null ? countsNode : null}
      <span class="hwc-active-band-jump" aria-hidden="true">
        <ArrowRightIcon />
      </span>
      <button
        type="button"
        class="hwc-active-band-open"
        aria-label={`${workspace.label} をすべての一覧で開く`}
        title={branch === null ? workspace.label : `${workspace.label} · ${branch}`}
        onClick={props.onOpen}
      />
    </div>
  );
}

function bandId(workspaceId: string): string {
  return `hwc-active-band-${workspaceId}`;
}

// ツリーでそのスペースの見出し（メニューの入口）まで送るための目印。
function spaceId(workspaceId: string): string {
  return `hwc-space-${workspaceId}`;
}

// ワークスペース（ワークツリー）ごとに束ねた行を並べる。束は PaneList が activeGroups で作る。
// 開いた時点では既読を送らない。保留は App が持ち、選択が離れた時点で done なら送る。
function ActivePaneList(props: PaneListProps & { groups: readonly ActiveGroup[] }) {
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
              const name = paneRowTitle(pane);
              return (
                <li key={pane.id} class="hwc-active-row">
                  <button
                    type="button"
                    class="hwc-active-open"
                    data-current={current}
                    data-slot={current ? (props.currentSlot ?? undefined) : undefined}
                    aria-current={current ? "true" : undefined}
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
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function PaneList(props: PaneListProps) {
  // スコープごとの位置を控える。中身が総入れ替えになるので、ブラウザに任せると
  // 先頭や途中の位置へ飛ぶ。
  const scroll = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<ListScope, number>());

  const changeScope = (next: ListScope) => {
    if (scroll.current) positions.current.set(props.scope, scroll.current.scrollTop);
    props.onScope(next);
  };

  useLayoutEffect(() => {
    const node = scroll.current;
    if (node) node.scrollTop = positions.current.get(props.scope) ?? 0;
  }, [props.scope]);

  // 削除が確定した行は、高さを詰めながら淡く消す。行が途中で切り落とされないよう、
  // スナップショットの適用はアニメーションの完了を待ってから行う（App）。
  const removalFinished = useRef(props.onRemovalFinished);
  removalFinished.current = props.onRemovalFinished;
  const removalPhase = props.removal?.phase ?? null;
  const removalId = props.removal?.workspaceId ?? null;
  useLayoutEffect(() => {
    if (removalPhase !== "leave") return;
    const node = document.querySelector<HTMLElement>('[data-removal="leave"]');
    const finish = () => removalFinished.current();
    if (
      node === null ||
      typeof node.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      finish();
      return;
    }

    const style = getComputedStyle(node);
    node.style.overflow = "hidden";
    const animation = node.animate(
      [
        {
          height: `${node.offsetHeight}px`,
          marginTop: style.marginTop,
          marginBottom: style.marginBottom,
          opacity: 1,
        },
        { height: "0px", marginTop: "0px", marginBottom: "0px", opacity: 0 },
      ],
      { duration: 220, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
    );
    let active = true;
    const settle = () => {
      if (active) finish();
    };
    void animation.finished.then(settle, settle);
    return () => {
      active = false;
    };
  }, [removalId, removalPhase]);

  // 帯から移ったときは、そのスペースの見出しまで送る。スコープの復元より後に置き、
  // 復元した位置を上書きする。同じ要求で二度動かないよう、token で 1 回だけ処理する。
  const revealed = useRef<number | null>(null);
  useLayoutEffect(() => {
    const request = props.reveal;
    if (request === null || props.scope !== "all") return;
    if (revealed.current === request.token) return;
    revealed.current = request.token;

    const node = scroll.current;
    const bodyNode = body.current;
    const target = document.getElementById(spaceId(request.workspaceId));
    if (node === null || bodyNode === null || target === null) return;
    const padding = Number.parseFloat(getComputedStyle(bodyNode).paddingTop) || 0;
    const top =
      target.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTop = Math.max(0, top - padding);
    // キーボードでも続けられるよう、移動先の見出しへフォーカスを送る。次の Tab がメニュー。
    target.querySelector<HTMLElement>(".hwc-group")?.focus({ preventScroll: true });
  }, [props.scope, props.reveal]);

  if (countPanes(props.state) === 0) return <NoPanes />;

  // 件数は一覧に出ている帯（スペース）の数。行を数え直さず、同じ束をそのまま使う。
  const groups = activeGroups(props.state);

  // 帯からの移動は、いまの active の位置を控えてからスコープを切り替える。
  const revealWorkspace = (workspaceId: string) => {
    changeScope("all");
    props.onRevealWorkspace(workspaceId);
  };

  // セグメントと一覧のスクロール枠は分岐の外に置く。スコープを切り替えても同じ要素を
  // 使い続けるので、つまみが滑り、スクロール枠も作り直されない。
  return (
    <>
      <ScopeBar scope={props.scope} count={groups.length} onScope={changeScope} />
      <div class="hwc-list-scroll" ref={scroll}>
        <div class="hwc-list-body" ref={body}>
          {renderList({ ...props, onRevealWorkspace: revealWorkspace }, groups)}
        </div>
      </div>
    </>
  );
}

// 並べ方の分岐はここ 1 か所。active の行はツリーと前提が違う。
function renderList(props: PaneListProps, groups: readonly ActiveGroup[]) {
  switch (props.scope) {
    case "active":
      return <ActivePaneList {...props} groups={groups} />;
    case "all":
      return <TreePaneList {...props} />;
  }
}

// マージ済みはタスクの終わり。タイトルの前に記号を置き、番号は帯とメニューに任せる。
// 開いている PR はレビュー中の現在地なので、タイトルだけで足りる。
function PullRequestSummary(props: { pullRequest: PullRequest | null; fallback: string }) {
  const pullRequest = props.pullRequest;
  if (pullRequest === null || pullRequestTone(pullRequest.state) !== "merged") {
    return <>{pullRequest?.title ?? props.fallback}</>;
  }
  return (
    <>
      <span class="hwc-merged-mark" role="img" aria-label="マージ済み" title="マージ済み">
        <MergeIcon size={13} />
      </span>{" "}
      {pullRequest.title}
    </>
  );
}

function TreePaneList(props: TreePaneListProps) {
  const { state, selectedPaneId, expanded, onSelect, onToggle, workingSince, now } = props;

  // ブランチはワークスペースの属性。行ごとに引き直さず、先にペイン id へ配る。
  const branchOf = new Map<string, string | null>();
  for (const workspace of state.workspaces) {
    const branch = workspace.branch ?? null;
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) branchOf.set(pane.id, branch);
    }
  }

  const toggle = (id: string) => () => onToggle(id);

  const groups = groupWorkspaces(state.workspaces);
  const units = orderUnits(groups, state.workspaces);
  const unitByKey = new Map(units.map((unit) => [unit.key, unit]));

  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dropGuide, setDropGuide] = useState<{ top: number } | null>(null);
  const moving = useRef(false);
  const pendingAnimation = useRef<{
    order: string;
    liftedKey: string;
    offsets: ReadonlyMap<string, number>;
  } | null>(null);
  const orderKey = units.map((unit) => unit.key).join("\n");

  // キーボード操作ではドラッグ側の offset が無い。状態が届く前の位置をここで控える。
  const readOffsets = (): Map<string, number> => {
    const offsets = new Map<string, number>();
    for (const node of document.querySelectorAll<HTMLElement>("[data-order-key]")) {
      const key = node.dataset.orderKey;
      if (key !== undefined) offsets.set(key, node.offsetTop);
    }
    return offsets;
  };

  // 送るのは、掴んだ束の全 id と落とし先の先頭 id。同じ位置なら送らない。
  const commit = (key: string, beforeKey: string | null, offsets?: ReadonlyMap<string, number>) => {
    const unit = unitByKey.get(key);
    if (unit === undefined || moving.current || !isOrderChange(units, key, beforeKey)) return;

    const rest = units.filter((item) => item.key !== key);
    const to = beforeKey === null ? rest.length : rest.findIndex((item) => item.key === beforeKey);
    if (to < 0) return;

    pendingAnimation.current = {
      order: orderKey,
      liftedKey: key,
      offsets: offsets ?? readOffsets(),
    };
    moving.current = true;
    setNotice(null);
    void props.onMoveWorkspaces(unit.ids, dropBeforeId(units, beforeKey)).then(
      (ok) => {
        if (ok) setAnnouncement(`${unit.label} を ${to + 1} 番目に移動しました`);
        else {
          pendingAnimation.current = null;
          setNotice("並べ替えを保存できませんでした。");
        }
        moving.current = false;
      },
      () => {
        pendingAnimation.current = null;
        setNotice("並べ替えを保存できませんでした。");
        moving.current = false;
      },
    );
  };

  // 状態が新しい順序で描き直された直後、ドロップ前の位置との差分を transform で戻す。
  // 位置は offsetTop なのでスクロール位置に影響されない。
  useLayoutEffect(() => {
    const pendingMove = pendingAnimation.current;
    if (pendingMove === null) return;
    // 応答の期限は API 側（10 秒）と失敗時の掃除に任せる。遅い応答でもアニメーションする。
    if (orderKey === pendingMove.order) return;
    pendingAnimation.current = null;
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

  const onOrderKeyDown = (key: string, event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const beforeKey = adjacentBeforeKey(units, key, event.key === "ArrowUp" ? -1 : 1);
    if (beforeKey === undefined) return;
    commit(key, beforeKey);
  };

  const orderDrag = useOrderDrag({
    units,
    onDrop: (drop) => commit(drop.key, drop.beforeKey, drop.offsets),
  });
  const dragged = orderDrag.drag;
  const lastRemainingKey =
    dragged === null
      ? null
      : (units.filter((unit) => unit.key !== dragged.key).at(-1)?.key ?? null);
  // 「ここに移動」の線を、落とし先のブロックの境界に置く。無変化なら出さない。
  useLayoutEffect(() => {
    if (dragged === null || dragged.anchor === undefined) {
      setDropGuide(null);
      return;
    }
    if (!isOrderChange(units, dragged.key, dragged.anchor)) {
      setDropGuide(null);
      return;
    }

    const targetKey = dragged.anchor ?? lastRemainingKey;
    if (targetKey === null) {
      setDropGuide(null);
      return;
    }
    const node = Array.from(document.querySelectorAll<HTMLElement>("[data-order-key]")).find(
      (item) => item.dataset.orderKey === targetKey,
    );
    if (node === undefined) {
      setDropGuide(null);
      return;
    }

    const edge = dragged.anchor === null ? "after" : "before";
    // 先頭の前へ落とすときは、ラベルがスクロール領域の上端で切れないよう少し下げる。
    const top = Math.max(
      12,
      edge === "before" ? node.offsetTop - 8 : node.offsetTop + node.offsetHeight + 8,
    );
    setDropGuide((current) => (current !== null && current.top === top ? current : { top }));
  }, [dragged, lastRemainingKey, orderKey, units]);

  function renderHeader(props2: {
    id: string;
    depth: number;
    icon: ComponentChildren;
    label: string;
    sub: ComponentChildren;
    title?: string;
    status: PaneState["agentStatus"];
    agents: number;
    // 場所の束だけが持つ。同じ場所を指すスペースの数。
    spaces?: number;
    controlsId: string;
    workspaceId?: string;
    sync?: GitSync | null;
    // 代表の見出しを持たないホスト（リポジトリ束の先頭）は、束の見出しをその場所の入口にする。
    domId?: string;
    // 最上位の束だけが並べ替えの対象。子のワークスペース見出しには渡さない。
    order?: OrderUnit;
  }) {
    const open = expanded.has(props2.id);
    const workspaceId = props2.workspaceId;
    const sync = props2.sync ?? null;
    const order = props2.order;
    const orderProps =
      order === undefined
        ? {}
        : {
            onPointerDown: orderDrag.begin(order.key, order.label),
            onPointerMove: orderDrag.move,
            onPointerUp: orderDrag.up,
            onPointerCancel: orderDrag.cancel,
            onLostPointerCapture: orderDrag.lostCapture,
            onClickCapture: orderDrag.clickCapture,
            onContextMenu: orderDrag.contextMenu,
            onKeyDown: (event: KeyboardEvent) => onOrderKeyDown(order.key, event),
            "aria-keyshortcuts": "ArrowUp ArrowDown",
          };
    return (
      <div
        class="hwc-group-row"
        data-menu={workspaceId !== undefined}
        data-reveal={
          workspaceId !== undefined && props.reveal?.workspaceId === workspaceId
            ? "true"
            : undefined
        }
        id={props2.domId}
      >
        {workspaceId === undefined ? (
          <span class="hwc-space-icon hwc-space-icon--static" aria-hidden="true">
            <span class="hwc-group-icon">{props2.icon}</span>
          </span>
        ) : (
          <button
            type="button"
            class="hwc-space-icon"
            aria-label={`${props2.label} のメニュー`}
            aria-haspopup="menu"
            aria-expanded={props.openWorkspaceMenuId === workspaceId}
            aria-controls={MENU_ID}
            data-open={props.openWorkspaceMenuId === workspaceId}
            onClick={(event) => props.onWorkspaceMenu(workspaceId, event.currentTarget)}
          >
            <span class="hwc-group-icon">{props2.icon}</span>
          </button>
        )}
        <button
          type="button"
          class="hwc-group"
          data-depth={props2.depth}
          title={props2.title}
          aria-expanded={open}
          aria-controls={props2.controlsId}
          onClick={toggle(props2.id)}
          {...orderProps}
        >
          <span class="hwc-group-main">
            <span class="hwc-group-title">
              <span class="hwc-group-name">{props2.label}</span>
              {props2.spaces === undefined || props2.spaces < 2 ? null : (
                <GroupSpaces spaces={props2.spaces} />
              )}
              {props2.agents === 0 ? null : <GroupAgents agents={props2.agents} />}
            </span>
            <span class="hwc-group-sub">{props2.sub}</span>
          </span>
          <GroupStatus status={props2.status} agents={props2.agents} hidden={open} />
          <span class="hwc-chevron" data-open={open}>
            <ChevronRightIcon />
          </span>
        </button>
        <GitCount sync={sync} />
      </div>
    );
  }

  function renderTabs(tab: TabState, depth: number) {
    const tabOpen = expanded.has(tab.id);
    const tabGroupId = `hwc-group-${tab.id}`;
    const agents = countTabAgents(tab);
    return (
      <li class="hwc-tab-block" key={tab.id}>
        <button
          type="button"
          class="hwc-tabrow"
          data-depth={depth}
          aria-expanded={tabOpen}
          aria-controls={tabGroupId}
          onClick={toggle(tab.id)}
        >
          <span class="hwc-tabrow-main">
            <span class="hwc-tabrow-title">
              <span class="hwc-tabrow-name">{tab.label}</span>
              {agents === 0 ? null : <GroupAgents agents={agents} />}
            </span>
            <span class="hwc-tabrow-sub">
              {agents === 0 ? agentPresence(agents) : `${tab.panes.length} ペイン`}
            </span>
          </span>
          <GroupStatus status={tab.agentStatus} agents={agents} hidden={tabOpen} />
          <span class="hwc-chevron" data-open={tabOpen}>
            <ChevronRightIcon />
          </span>
        </button>
        <GroupChildren id={tabGroupId} open={tabOpen}>
          {renderPanes(tab, depth)}
        </GroupChildren>
      </li>
    );
  }

  function renderPanes(tab: TabState, depth: number) {
    return (
      <ul class="hwc-panes" data-depth={depth}>
        {tab.panes.map((pane) => {
          const startedAt = workingSince.get(pane.id);
          const branch = branchOf.get(pane.id) ?? null;
          return (
            // 狭い行の判定は、行そのものではなくこの枠の幅で行う。
            <li key={pane.id} class="hwc-pane-row">
              <div
                class="hwc-pane"
                data-pane-id={pane.id}
                data-current={pane.id === selectedPaneId}
                data-slot={
                  pane.id === selectedPaneId ? (props.currentSlot ?? undefined) : undefined
                }
              >
                <button
                  type="button"
                  class="hwc-pane-open"
                  aria-current={pane.id === selectedPaneId ? "true" : undefined}
                  onClick={() => onSelect(pane.id)}
                >
                  <span class={pane.agent === null ? "hwc-pane-icon" : "hwc-pane-state"}>
                    {pane.agent === null ? <PaneIcon /> : <StatusLabel status={pane.agentStatus} />}
                  </span>
                  <span class="hwc-pane-main">
                    <span class="hwc-pane-title">
                      {pane.agent === null ? null : (
                        <span class="hwc-pane-agent" data-agent={agentGlyph(pane.agent)}>
                          <AgentGlyphIcon agent={pane.agent} size={14} />
                        </span>
                      )}
                      <span class="hwc-pane-name">{paneRowTitle(pane)}</span>
                      {props.parentPaneIds.has(pane.id) ? <ParentMark /> : null}
                    </span>
                    {branch === null ? null : (
                      <span class="hwc-pane-sub" title={branch}>
                        {branch}
                      </span>
                    )}
                  </span>
                  {startedAt === undefined ? null : (
                    <span class="hwc-pane-elapsed" data-tone="active">
                      {formatElapsed(now - startedAt)}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  class="hwc-pane-more"
                  aria-label={`${pane.id} のメニュー`}
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
    );
  }

  // タブ行には 2 つの役割がある。複数のタブを束ねる見出しであることと、見出し行を
  // 持たないスペース（リポジトリ束ねの host）で開閉を持つ唯一の行であること。
  // 省けるのは、スペース自身の見出しが開閉を持つときだけ。
  function renderTabLevel(
    workspace: AppState["workspaces"][number],
    depth: number,
    headerOwnsOpen: boolean,
  ) {
    const sole = headerOwnsOpen ? soleTab(workspace) : null;
    if (sole !== null) return renderPanes(sole, depth);
    return (
      <ul class="hwc-tabs-list" data-depth={depth}>
        {workspace.tabs.map((tab) => renderTabs(tab, depth))}
      </ul>
    );
  }

  // ワークスペース 1 つ分。ワークツリーが 1 つだけなら、これが一覧の 1 ブロックになる。
  function renderWorkspace(
    workspace: AppState["workspaces"][number],
    depth: number,
    withHeader: boolean,
    order?: OrderUnit,
    header?: { label?: string; sub?: ComponentChildren },
  ) {
    const groupId = `hwc-group-${workspace.id}`;
    const open = expanded.has(workspace.id);
    const pullRequest = props.pullRequests.get(workspace.id) ?? null;
    const agents = countWorkspaceAgents(workspace);
    const panes = countWorkspacePanes(workspace.id, state);
    return (
      <section
        class="hwc-group-block"
        data-depth={depth}
        id={spaceId(workspace.id)}
        key={workspace.id}
        data-order-key={order?.key}
        data-dragging={order !== undefined && dragged?.key === order.key ? "true" : undefined}
        data-removal={props.removal?.workspaceId === workspace.id ? props.removal.phase : undefined}
      >
        {withHeader
          ? renderHeader({
              id: workspace.id,
              depth,
              icon: <WorkspaceGlyph worktree={workspace.worktree} />,
              label: header?.label ?? workspace.label,
              sub: header?.sub ?? (
                <PullRequestSummary
                  pullRequest={pullRequest}
                  fallback={
                    agents === 0
                      ? agentPresence(agents)
                      : workspace.worktree?.isLinkedWorktree === true
                        ? `${workspace.worktree.repoName} · ${panes} ペイン`
                        : `${panes} ペイン`
                  }
                />
              ),
              title: workspace.worktree?.checkoutPath ?? workspace.path ?? undefined,
              status: workspace.agentStatus,
              agents,
              controlsId: groupId,
              workspaceId: workspace.id,
              sync: workspace.sync ?? null,
              order,
            })
          : null}
        <GroupChildren id={groupId} open={withHeader ? open : true}>
          {renderTabLevel(workspace, withHeader ? depth + 1 : depth, withHeader)}
        </GroupChildren>
      </section>
    );
  }

  // 同じ場所を指す Herdr ネイティブのスペース。見出しは場所で 1 つにし、代表の
  // 中身を直下に置く。余分なスペースは子の見出しにして、閉じる入口を残す。
  function renderPlaceGroup(group: WorkspaceGroup, order: OrderUnit | undefined) {
    const members = groupMembers(group);
    const representative = members[0];
    if (group.place === null || representative === undefined) return null;
    const extras = members.slice(1);
    const open = expanded.has(group.key);
    const groupId = `hwc-group-${group.key}`;
    const agents = members.reduce((total, workspace) => total + countWorkspaceAgents(workspace), 0);
    const panes = members.reduce(
      (total, workspace) => total + countWorkspacePanes(workspace.id, state),
      0,
    );
    const pullRequest = props.pullRequests.get(representative.id) ?? null;
    return (
      <section
        class="hwc-group-block"
        data-depth={0}
        key={group.key}
        data-order-key={group.key}
        data-dragging={dragged?.key === group.key ? "true" : undefined}
        data-removal={
          props.removal?.workspaceId === representative.id ? props.removal.phase : undefined
        }
      >
        {renderHeader({
          id: group.key,
          depth: 0,
          icon: <WorkspaceGlyph worktree={representative.worktree} />,
          label: group.place.label,
          sub: (
            <PullRequestSummary
              pullRequest={pullRequest}
              fallback={agents === 0 ? agentPresence(agents) : `${panes} ペイン`}
            />
          ),
          title: group.place.path,
          status: mostUrgentStatus(members.map((workspace) => workspace.agentStatus)),
          agents,
          spaces: members.length,
          controlsId: groupId,
          workspaceId: representative.id,
          sync: representative.sync ?? null,
          domId: spaceId(representative.id),
          order,
        })}
        <GroupChildren id={groupId} open={open}>
          {renderTabLevel(representative, 1, true)}
          {extras.map((workspace, index) =>
            renderWorkspace(workspace, 1, true, undefined, {
              label: `スペース ${index + 2}`,
              sub: `${countWorkspacePanes(workspace.id, state)} ペイン`,
            }),
          )}
        </GroupChildren>
      </section>
    );
  }

  return (
    <>
      {notice === null ? null : (
        <p class="hwc-list-notice" role="alert">
          {notice}
        </p>
      )}
      <p class="hwc-visually-hidden" role="status">
        {announcement}
      </p>
      {groups.map((group) => {
        const order = unitByKey.get(group.key);
        if (group.place !== null) return renderPlaceGroup(group, order);
        // 同じリポジトリのワークツリーが複数あるときだけ、リポジトリで束ねる。
        if (group.repoName === null || group.linked.length === 0) {
          const only = group.host ?? group.linked[0];
          return renderWorkspace(only, 0, true, order);
        }

        const open = expanded.has(group.key);
        const groupId = `hwc-group-${group.key}`;
        const worktrees = group.linked.length + (group.host ? 1 : 0);
        const agents = [group.host, ...group.linked].reduce(
          (total, workspace) => total + (workspace === null ? 0 : countWorkspaceAgents(workspace)),
          0,
        );
        // ホストは自分の見出しを持たない。束の見出しがホストの入口も兼ねるので、
        // ホストに PR があればそのタイトルを出す。無ければ今までどおりワークツリー数。
        const hostPullRequest =
          group.host === null ? null : (props.pullRequests.get(group.host.id) ?? null);
        return (
          <section
            class="hwc-group-block"
            data-depth={0}
            key={group.key}
            data-order-key={group.key}
            data-dragging={dragged?.key === group.key ? "true" : undefined}
          >
            {renderHeader({
              id: group.key,
              depth: 0,
              icon: <RepoIcon />,
              label: group.repoName,
              sub: (
                <PullRequestSummary
                  pullRequest={hostPullRequest}
                  fallback={agents === 0 ? agentPresence(agents) : `${worktrees} ワークツリー`}
                />
              ),
              title: group.host?.worktree?.repoRoot ?? undefined,
              status: group.host?.agentStatus ?? group.linked[0]?.agentStatus ?? "unknown",
              agents,
              controlsId: groupId,
              workspaceId: group.host?.id,
              sync: group.host?.sync ?? null,
              domId: group.host === null ? undefined : spaceId(group.host.id),
              order,
            })}
            <GroupChildren id={groupId} open={open}>
              {group.host ? renderTabLevel(group.host, 1, false) : null}
              {group.linked.map((workspace) => renderWorkspace(workspace, 1, true))}
            </GroupChildren>
          </section>
        );
      })}
      {dropGuide === null ? null : (
        <>
          <div class="hwc-order-drop" style={{ top: `${dropGuide.top}px` }} aria-hidden="true" />
          <span
            class="hwc-order-drop-label"
            style={{ top: `${dropGuide.top}px` }}
            aria-hidden="true"
          >
            ここに移動
          </span>
        </>
      )}
      {dragged === null ? null : (
        <div class="hwc-order-ghost" aria-hidden="true">
          <span class="hwc-order-ghost-grip">
            <GripIcon size={16} />
          </span>
          <span class="hwc-order-ghost-name">{dragged.label}</span>
        </div>
      )}
    </>
  );
}
