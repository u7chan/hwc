import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AppState, PaneState, TabState, WorktreeState } from "../server/herdr/state";
import { copyText } from "./copy";
import {
  AgentGlyphIcon,
  ChevronRightIcon,
  CopyGlyph,
  MoreIcon,
  PaneIcon,
  RepoIcon,
  WorkspaceIcon,
  WorktreeIcon,
} from "./icons";
import {
  agentGlyph,
  countPanes,
  countWorkspacePanes,
  groupWorkspaces,
  paneRowTitle,
  soleTab,
} from "./select";
import {
  activeUnreadCount,
  activeViewRows,
  scopeWorkspaces,
  shouldFocusPane,
  unreadLabel,
  type ListScope,
  type TreeScope,
} from "./scope";
import type { SentPane } from "./sent";
import { StatusIcon, StatusLabel } from "./StatusLabel";
import { finishedMs, formatElapsed, workingMs } from "./time";

type PaneListProps = {
  state: AppState;
  selectedPaneId: string | null;
  scope: ListScope;
  onScope: (scope: ListScope) => void;
  expanded: ReadonlySet<string>;
  onSelect: (paneId: string) => void;
  onFocus: (paneId: string) => void;
  onToggle: (groupId: string) => void;
  workingSince: ReadonlyMap<string, number>;
  finishedAt: ReadonlyMap<string, number>;
  sent: ReadonlyMap<string, SentPane>;
  now: number;
};

type TreePaneListProps = Omit<PaneListProps, "scope" | "onScope" | "onFocus"> & {
  scope: TreeScope;
};

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

const SCOPE_OPTIONS: readonly { scope: ListScope; label: string }[] = [
  { scope: "agent", label: "エージェント" },
  { scope: "active", label: "アクティブ" },
  { scope: "all", label: "すべて" },
];

function ScopeBar(props: {
  scope: ListScope;
  unread: number;
  onScope: (scope: ListScope) => void;
}) {
  return (
    <div class="hwc-scope" role="group" aria-label="一覧の絞り込み" data-scope={props.scope}>
      <span class="hwc-scope-thumb" aria-hidden="true" />
      {SCOPE_OPTIONS.map((option) => {
        // 未読は「アクティブ」の意味そのもの。0 のときは何も出さない。
        const unread = option.scope === "active" ? props.unread : 0;
        return (
          <button
            key={option.scope}
            type="button"
            class="hwc-scope-option"
            aria-pressed={props.scope === option.scope}
            aria-label={unread > 0 ? `${option.label}、未読 ${unread} 件` : undefined}
            onClick={() => props.onScope(option.scope)}
          >
            {option.label}
            {unread > 0 && (
              <span class="hwc-scope-count" aria-hidden="true">
                {unreadLabel(unread)}
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

// 上段は所在。タブ名が無いスペースでは区切りごと落とす。
function activePlace(workspaceLabel: string, tabLabel: string): string {
  return tabLabel === "" ? workspaceLabel : `${workspaceLabel} · ${tabLabel}`;
}

// 右端は「あとどれだけ待つか」。要対応だけは時刻ではなく言葉で示す。
function ActiveTrail(props: {
  pane: PaneState;
  workingSince: ReadonlyMap<string, number>;
  finishedAt: ReadonlyMap<string, number>;
  now: number;
}) {
  if (props.pane.agentStatus === "blocked") {
    return <span class="hwc-active-flag">要対応</span>;
  }
  const ms =
    props.pane.agentStatus === "working"
      ? workingMs(props.workingSince, props.pane.id, props.now)
      : finishedMs(props.finishedAt, props.pane.id, props.now);
  return ms === null ? null : <span class="hwc-pane-elapsed">{formatElapsed(ms)}</span>;
}

// 窓口と状態の行を 1 行ずつ並べる。ツリーを畳まないので、どのスペースのどのタブで
// 動いているかがそのまま読める。並びは activeViewRows が持つ。
function ActivePaneList(props: PaneListProps) {
  const rows = activeViewRows(props.state, props.sent);
  if (rows.length === 0) {
    return (
      <div class="hwc-list-note">
        <p class="hwc-list-note-title">窓口も動いているエージェントもいません</p>
        <p class="hwc-list-note-text">
          メッセージを送ったペインと、実行中・要対応・完了のエージェントがここに並びます。「エージェント」に切り替えると、待機中のものも出ます。
        </p>
      </div>
    );
  }

  return (
    <ul class="hwc-active">
      {rows.map(({ workspace, tab, pane }) => {
        const current = pane.id === props.selectedPaneId;
        return (
          <li key={pane.id} class="hwc-active-row">
            <button
              type="button"
              class="hwc-active-open"
              data-current={current}
              aria-current={current ? "true" : undefined}
              onClick={() => {
                props.onSelect(pane.id);
                // 既読が進むのは done だけ。working / blocked では TUI のフォーカスを動かさない。
                if (shouldFocusPane(props.scope, pane.agentStatus)) props.onFocus(pane.id);
              }}
            >
              <StatusIcon status={pane.agentStatus} />
              <span class="hwc-active-main">
                <span class="hwc-active-place">{activePlace(workspace.label, tab.label)}</span>
                <span class="hwc-active-name">{pane.label ?? pane.agent}</span>
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

  if (countPanes(props.state) === 0) return <NoPanes />;

  // セグメントと一覧のスクロール枠は分岐の外に置く。スコープを切り替えても同じ要素を
  // 使い続けるので、つまみが滑り、スクロール枠も作り直されない。
  return (
    <>
      <ScopeBar scope={props.scope} unread={activeUnreadCount(props.state)} onScope={changeScope} />
      <div class="hwc-list-scroll" ref={scroll}>
        {renderList(props)}
      </div>
    </>
  );
}

// 並べ方の分岐はここ 1 か所。active の行はツリーの絞り込みと前提が違うので、
// scopeWorkspaces に active を渡さないよう型で分ける。
function renderList(props: PaneListProps) {
  switch (props.scope) {
    case "active":
      return <ActivePaneList {...props} />;
    case "agent":
    case "all":
      return <TreePaneList {...props} scope={props.scope} />;
  }
}

function TreePaneList(props: TreePaneListProps) {
  const { state, selectedPaneId, scope, expanded, onSelect, onToggle, workingSince, now } = props;

  const visible = scopeWorkspaces(state.workspaces, scope, selectedPaneId);

  // メニューは行の中に置くと一覧のスクロールで切れる。画面に固定して出す。
  const [menu, setMenu] = useState<{ paneId: string; top: number; right: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const openMenu = (event: MouseEvent, paneId: string) => {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    setCopied(false);
    // 画面の下で切れないように、はみ出す分だけ上へ寄せる。
    const height = 96;
    const top = Math.min(rect.bottom + 4, window.innerHeight - height - 8);
    setMenu({ paneId, top, right: window.innerWidth - rect.right });
  };

  const closeMenu = () => setMenu(null);

  const copyId = (paneId: string) => {
    void copyText(paneId).then((done) => setCopied(done));
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const onMove = () => setMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [menu]);

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
  }) {
    const open = expanded.has(props2.id);
    return (
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
                    {branch === null ? null : <span class="hwc-pane-sub">{branch}</span>}
                  </span>
                  {startedAt === undefined ? null : (
                    <span class="hwc-pane-elapsed">{formatElapsed(now - startedAt)}</span>
                  )}
                </button>
                <button
                  type="button"
                  class="hwc-pane-more"
                  aria-label={`${pane.id} のメニュー`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.paneId === pane.id}
                  onClick={(event) => openMenu(event, pane.id)}
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
    return (
      <section class="hwc-group-block" data-depth={depth} key={workspace.id}>
        {withHeader
          ? renderHeader({
              id: workspace.id,
              depth,
              icon: <WorkspaceGlyph worktree={workspace.worktree} />,
              label: workspace.label,
              sub:
                workspace.worktree?.isLinkedWorktree === true
                  ? `${workspace.worktree.repoName} · ${countWorkspacePanes(workspace.id, state)} ペイン`
                  : `${countWorkspacePanes(workspace.id, state)} ペイン`,
              title: workspace.worktree?.checkoutPath ?? undefined,
              status: workspace.agentStatus,
              controlsId: groupId,
            })
          : null}
        <GroupChildren id={groupId} open={withHeader ? open : true}>
          {renderTabLevel(workspace, withHeader ? depth + 1 : depth, withHeader)}
        </GroupChildren>
      </section>
    );
  }

  if (visible.length === 0) {
    return (
      <div class="hwc-list-note">
        <p class="hwc-list-note-title">エージェントのあるスペースがありません</p>
        <p class="hwc-list-note-text">「すべて」に切り替えると、ターミナルのスペースも出ます。</p>
      </div>
    );
  }

  return (
    <>
      {groupWorkspaces(visible).map((group) => {
        // 同じリポジトリのワークツリーが複数あるときだけ、リポジトリで束ねる。
        if (group.repoName === null || group.linked.length === 0) {
          const only = group.host ?? group.linked[0];
          return renderWorkspace(only, 0, true);
        }

        const open = expanded.has(group.key);
        const groupId = `hwc-group-${group.key}`;
        return (
          <section class="hwc-group-block" data-depth={0} key={group.key}>
            {renderHeader({
              id: group.key,
              depth: 0,
              icon: <RepoIcon />,
              label: group.repoName,
              sub: `${group.linked.length + (group.host ? 1 : 0)} ワークツリー`,
              title: group.host?.worktree?.repoRoot ?? undefined,
              status: group.host?.agentStatus ?? group.linked[0]?.agentStatus ?? "unknown",
              controlsId: groupId,
            })}
            <GroupChildren id={groupId} open={open}>
              {group.host ? renderTabLevel(group.host, 1, false) : null}
              {group.linked.map((workspace) => renderWorkspace(workspace, 1, true))}
            </GroupChildren>
          </section>
        );
      })}
      {menu ? (
        <>
          <div class="hwc-menu-backdrop" onPointerDown={closeMenu} />
          <div
            class="hwc-menu"
            role="menu"
            aria-label={`${menu.paneId} の操作`}
            style={{ top: `${menu.top}px`, right: `${menu.right}px` }}
          >
            <p class="hwc-menu-head">{menu.paneId}</p>
            <button
              type="button"
              role="menuitem"
              class="hwc-menu-item"
              onClick={() => copyId(menu.paneId)}
            >
              <CopyGlyph copied={copied} />
              {copied ? "コピーしました" : "ペイン ID をコピー"}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
