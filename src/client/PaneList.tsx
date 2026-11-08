import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { AppState, PaneState, TabState, WorktreeState } from "../server/herdr/state";
import type { PullRequest } from "../shared/pull-request";
import {
  AgentGlyphIcon,
  ArrowRightIcon,
  ChevronRightIcon,
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
  countWorkspacePanes,
  groupWorkspaces,
  paneRowTitle,
  soleTab,
  statusLabel,
  statusTone,
} from "./select";
import {
  activeGroups,
  countLabel,
  showsTabName,
  type ActiveGroup,
  type ActiveStatus,
  type ListScope,
} from "./scope";
import { MENU_ID } from "./Menu";
import type { SentPane } from "./sent";
import { StatusIcon, StatusLabel } from "./StatusLabel";
import { finishedClock, formatElapsed, workingMs } from "./time";

type PaneListProps = {
  state: AppState;
  selectedPaneId: string | null;
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
  workingSince: ReadonlyMap<string, number>;
  finishedAt: ReadonlyMap<string, number>;
  sent: ReadonlyMap<string, SentPane>;
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
function GroupStatus(props: { status: PaneState["agentStatus"]; hidden: boolean }) {
  return (
    <span class="hwc-group-status" data-hidden={props.hidden}>
      <StatusLabel status={props.status} />
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
}) {
  const { workspace, counts } = props.group;
  const branch = workspace.branch ?? null;
  const pullRequest = props.pullRequest;
  // PR が無いときは今までどおりブランチを出す。PR があれば、merge 後もタスク名を残す。
  const summary = pullRequest?.title ?? branch;
  return (
    <div class="hwc-active-band">
      <span class="hwc-active-band-icon">
        <WorkspaceGlyph worktree={workspace.worktree} />
      </span>
      <div class="hwc-active-band-main">
        <div class="hwc-active-band-title">
          <h2 class="hwc-active-band-name" id={bandId(workspace.id)}>
            {workspace.label}
          </h2>
          {pullRequest?.state === "OPEN" ? (
            <a
              class="hwc-active-band-pr"
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`PR #${pullRequest.number} を GitHub で開く`}
            >
              #{pullRequest.number}
            </a>
          ) : null}
        </div>
        {summary === null ? null : (
          <p
            class={pullRequest === null ? "hwc-active-band-branch" : "hwc-active-band-summary"}
            title={summary}
          >
            {summary}
          </p>
        )}
      </div>
      <div class="hwc-active-band-counts">
        {COUNT_STATUSES.map((status) => (
          <ActiveCount key={status} status={status} count={counts[status]} />
        ))}
      </div>
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
        <p class="hwc-list-note-title">窓口も動いているエージェントもいません</p>
        <p class="hwc-list-note-text">
          メッセージを送ったペインと、実行中・要対応・完了のエージェントがここに並びます。待機中のペインは「すべて」に出ます。
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
        >
          <ActiveBand
            group={group}
            pullRequest={props.pullRequests.get(group.workspace.id) ?? null}
            onOpen={() => props.onRevealWorkspace(group.workspace.id)}
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
                    aria-current={current ? "true" : undefined}
                    onClick={() => props.onOpen(pane.id)}
                  >
                    <StatusIcon status={pane.agentStatus} />
                    <span class="hwc-active-main">
                      <span class="hwc-active-name" title={name}>
                        {activeRowName(group.workspace.label, name)}
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
  const positions = useRef(new Map<ListScope, number>());

  const changeScope = (next: ListScope) => {
    if (scroll.current) positions.current.set(props.scope, scroll.current.scrollTop);
    props.onScope(next);
  };

  useLayoutEffect(() => {
    const node = scroll.current;
    if (node) node.scrollTop = positions.current.get(props.scope) ?? 0;
  }, [props.scope]);

  // 帯から移ったときは、そのスペースの見出しまで送る。スコープの復元より後に置き、
  // 復元した位置を上書きする。同じ要求で二度動かないよう、token で 1 回だけ処理する。
  const revealed = useRef<number | null>(null);
  useLayoutEffect(() => {
    const request = props.reveal;
    if (request === null || props.scope !== "all") return;
    if (revealed.current === request.token) return;
    revealed.current = request.token;

    const node = scroll.current;
    const target = document.getElementById(spaceId(request.workspaceId));
    if (node === null || target === null) return;
    const padding = Number.parseFloat(getComputedStyle(node).paddingTop) || 0;
    const top =
      target.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTop = Math.max(0, top - padding);
    // キーボードでも続けられるよう、移動先の見出しへフォーカスを送る。次の Tab がメニュー。
    target.querySelector<HTMLElement>(".hwc-group")?.focus({ preventScroll: true });
  }, [props.scope, props.reveal]);

  if (countPanes(props.state) === 0) return <NoPanes />;

  // 件数は一覧に出ている帯（スペース）の数。行を数え直さず、同じ束をそのまま使う。
  const groups = activeGroups(props.state, props.sent);

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
        {renderList({ ...props, onRevealWorkspace: revealWorkspace }, groups)}
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

  function renderHeader(props2: {
    id: string;
    depth: number;
    icon: ComponentChildren;
    label: string;
    sub: string;
    title?: string;
    status: PaneState["agentStatus"];
    controlsId: string;
    workspaceId?: string;
    // 代表の見出しを持たないホスト（リポジトリ束の先頭）は、束の見出しをその場所の入口にする。
    domId?: string;
  }) {
    const open = expanded.has(props2.id);
    const workspaceId = props2.workspaceId;
    return (
      <div class="hwc-group-row" data-menu={workspaceId !== undefined} id={props2.domId}>
        <button
          type="button"
          class="hwc-group"
          data-depth={props2.depth}
          title={props2.title}
          aria-expanded={open}
          aria-controls={props2.controlsId}
          onClick={toggle(props2.id)}
        >
          <span class="hwc-group-icon">{props2.icon}</span>
          <span class="hwc-group-main">
            <span class="hwc-group-name">{props2.label}</span>
            <span class="hwc-group-sub">{props2.sub}</span>
          </span>
          <GroupStatus status={props2.status} hidden={open} />
          <span class="hwc-chevron" data-open={open}>
            <ChevronRightIcon />
          </span>
        </button>
        {workspaceId === undefined ? null : (
          <button
            type="button"
            class="hwc-pane-more"
            aria-label={`${props2.label} のメニュー`}
            aria-haspopup="menu"
            aria-expanded={props.openWorkspaceMenuId === workspaceId}
            aria-controls={MENU_ID}
            onClick={(event) => props.onWorkspaceMenu(workspaceId, event.currentTarget)}
          >
            <MoreIcon />
          </button>
        )}
      </div>
    );
  }

  function renderTabs(tab: TabState, depth: number) {
    const tabOpen = expanded.has(tab.id);
    const tabGroupId = `hwc-group-${tab.id}`;
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
            <span class="hwc-tabrow-name">{tab.label}</span>
            <span class="hwc-tabrow-sub">{tab.panes.length} ペイン</span>
          </span>
          <GroupStatus status={tab.agentStatus} hidden={tabOpen} />
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
  ) {
    const groupId = `hwc-group-${workspace.id}`;
    const open = expanded.has(workspace.id);
    const pullRequest = props.pullRequests.get(workspace.id) ?? null;
    return (
      <section
        class="hwc-group-block"
        data-depth={depth}
        id={spaceId(workspace.id)}
        key={workspace.id}
      >
        {withHeader
          ? renderHeader({
              id: workspace.id,
              depth,
              icon: <WorkspaceGlyph worktree={workspace.worktree} />,
              label: workspace.label,
              sub:
                pullRequest?.title ??
                (workspace.worktree?.isLinkedWorktree === true
                  ? `${workspace.worktree.repoName} · ${countWorkspacePanes(workspace.id, state)} ペイン`
                  : `${countWorkspacePanes(workspace.id, state)} ペイン`),
              title: workspace.worktree?.checkoutPath ?? undefined,
              status: workspace.agentStatus,
              controlsId: groupId,
              workspaceId: workspace.id,
            })
          : null}
        <GroupChildren id={groupId} open={withHeader ? open : true}>
          {renderTabLevel(workspace, withHeader ? depth + 1 : depth, withHeader)}
        </GroupChildren>
      </section>
    );
  }

  return (
    <>
      {groupWorkspaces(state.workspaces).map((group) => {
        // 同じリポジトリのワークツリーが複数あるときだけ、リポジトリで束ねる。
        if (group.repoName === null || group.linked.length === 0) {
          const only = group.host ?? group.linked[0];
          return renderWorkspace(only, 0, true);
        }

        const open = expanded.has(group.key);
        const groupId = `hwc-group-${group.key}`;
        // ホストは自分の見出しを持たない。束の見出しがホストの入口も兼ねるので、
        // ホストに PR があればそのタイトルを出す。無ければ今までどおりワークツリー数。
        const hostPullRequest =
          group.host === null ? null : (props.pullRequests.get(group.host.id) ?? null);
        return (
          <section class="hwc-group-block" data-depth={0} key={group.key}>
            {renderHeader({
              id: group.key,
              depth: 0,
              icon: <RepoIcon />,
              label: group.repoName,
              sub:
                hostPullRequest?.title ??
                `${group.linked.length + (group.host ? 1 : 0)} ワークツリー`,
              title: group.host?.worktree?.repoRoot ?? undefined,
              status: group.host?.agentStatus ?? group.linked[0]?.agentStatus ?? "unknown",
              controlsId: groupId,
              workspaceId: group.host?.id,
              domId: group.host === null ? undefined : spaceId(group.host.id),
            })}
            <GroupChildren id={groupId} open={open}>
              {group.host ? renderTabLevel(group.host, 1, false) : null}
              {group.linked.map((workspace) => renderWorkspace(workspace, 1, true))}
            </GroupChildren>
          </section>
        );
      })}
    </>
  );
}
