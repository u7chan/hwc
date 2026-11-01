import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AppState, PaneState, TabState, WorktreeState } from "../server/herdr/state";
import { Confirm } from "./Confirm";
import {
  AgentGlyphIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  CopyGlyph,
  MoreIcon,
  PaneIcon,
  RepoIcon,
  WorkspaceIcon,
  WorktreeIcon,
} from "./icons";
import {
  agentGlyph,
  canMovePane,
  countPanes,
  countWorkspacePanes,
  groupWorkspaces,
} from "./select";
import { StatusLabel } from "./StatusLabel";
import { formatElapsed } from "./time";

type PaneListProps = {
  state: AppState;
  selectedPaneId: string | null;
  expanded: Set<string>;
  onSelect: (paneId: string) => void;
  onToggle: (groupId: string) => void;
  onClosePane: (paneId: string) => void;
  onDropPane: (paneId: string, targetPaneId: string, after: boolean) => void;
  onMovePaneStep: (paneId: string, delta: -1 | 1) => void;
  workingSince: ReadonlyMap<string, number>;
  now: number;
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

export function PaneList(props: PaneListProps) {
  const { state, selectedPaneId, expanded, onSelect, onToggle, workingSince, now } = props;

  // メニューは行の中に置くと一覧のスクロールで切れる。画面に固定して出す。
  const [menu, setMenu] = useState<{ paneId: string; top: number; right: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ paneId: string; after: boolean } | null>(null);
  const positions = useRef<Map<string, number>>(new Map());
  const order = useRef("");
  const listScroller = useRef<HTMLDivElement>(null);

  // 並びが変わったら、前の位置から今の位置まで滑らせる（FLIP）。
  useLayoutEffect(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".hwc-pane[data-pane-id]")];
    const next = new Map<string, number>();
    const animate =
      typeof window !== "undefined" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 位置は毎回測り直す（折りたたみでも動く）。動かすのは並びが変わったときだけ。
    const nextOrder = rows.map((row) => row.dataset.paneId ?? "").join(",");
    const reordered = nextOrder !== order.current;
    order.current = nextOrder;

    // 画面座標はスクロールで動く。動いたのは並びだけを見るため、スクロール量を足して測る。
    const scrolled = listScroller.current?.scrollTop ?? 0;

    for (const row of rows) {
      const id = row.dataset.paneId;
      if (!id) continue;
      const top = row.getBoundingClientRect().top + scrolled;
      next.set(id, top);
      const before = positions.current.get(id);
      if (!animate || !reordered || before === undefined || Math.abs(before - top) < 1) continue;

      row.style.transition = "none";
      row.style.transform = `translateY(${before - top}px)`;
      void row.offsetHeight;
      row.style.transition = "transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1)";
      row.style.transform = "";
    }

    positions.current = next;
    return () => {
      for (const row of rows) row.style.transition = "";
    };
  });

  const openMenu = (event: MouseEvent, paneId: string) => {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    setCopied(false);
    // 画面の下で切れないように、はみ出す分だけ上へ寄せる。
    const height = 250;
    const top = Math.min(rect.bottom + 4, window.innerHeight - height - 8);
    setMenu({ paneId, top, right: window.innerWidth - rect.right });
  };

  const closeMenu = () => setMenu(null);

  const copyId = (paneId: string) => {
    void navigator.clipboard
      ?.writeText(paneId)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
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
          return (
            <li key={pane.id}>
              <div
                class="hwc-pane"
                data-pane-id={pane.id}
                data-current={pane.id === selectedPaneId}
                data-dragging={dragged === pane.id}
                data-drop={
                  dropAt?.paneId === pane.id ? (dropAt.after ? "after" : "before") : undefined
                }
                draggable
                onDragStart={(event) => {
                  event.dataTransfer?.setData("text/plain", pane.id);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                  setDragged(pane.id);
                }}
                onDragEnd={() => {
                  setDragged(null);
                  setDropAt(null);
                }}
                onDragOver={(event) => {
                  if (dragged === null || dragged === pane.id) return;
                  event.preventDefault();
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  setDropAt({
                    paneId: pane.id,
                    after: event.clientY > rect.top + rect.height / 2,
                  });
                }}
                onDragLeave={() =>
                  setDropAt((current) => (current?.paneId === pane.id ? null : current))
                }
                onDrop={(event) => {
                  event.preventDefault();
                  const moved = event.dataTransfer?.getData("text/plain") ?? dragged;
                  const after = event.currentTarget.dataset.drop === "after";
                  setDragged(null);
                  setDropAt(null);
                  if (moved && moved !== pane.id) props.onDropPane(moved, pane.id, after);
                }}
              >
                <button
                  type="button"
                  class="hwc-pane-open"
                  aria-current={pane.id === selectedPaneId ? "true" : undefined}
                  onClick={() => onSelect(pane.id)}
                >
                  <span
                    class="hwc-pane-icon"
                    data-agent={agentGlyph(pane.agent)}
                    data-working={pane.agentStatus === "working"}
                  >
                    {pane.agent ? <AgentGlyphIcon agent={pane.agent} /> : <PaneIcon />}
                  </span>
                  <span class="hwc-pane-main">
                    <span class="hwc-pane-name">{pane.title ?? pane.agent ?? pane.id}</span>
                  </span>
                  {startedAt === undefined ? null : (
                    <span class="hwc-pane-elapsed">{formatElapsed(now - startedAt)}</span>
                  )}
                  <StatusLabel status={pane.agentStatus} />
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
          <ul class="hwc-tabs-list" data-depth={depth}>
            {workspace.tabs.map((tab) => renderTabs(tab, depth))}
          </ul>
        </GroupChildren>
      </section>
    );
  }

  if (countPanes(state) === 0) {
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

  return (
    <div class="hwc-list-scroll" ref={listScroller}>
      {groupWorkspaces(state).map((group) => {
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
              {group.host ? (
                <ul class="hwc-tabs-list" data-depth={1}>
                  {group.host.tabs.map((tab) => renderTabs(tab, 1))}
                </ul>
              ) : null}
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
              disabled={!canMovePane(state, menu.paneId, -1)}
              onClick={() => props.onMovePaneStep(menu.paneId, -1)}
            >
              <ChevronUpIcon />
              上へ移動
            </button>
            <button
              type="button"
              role="menuitem"
              class="hwc-menu-item"
              disabled={!canMovePane(state, menu.paneId, 1)}
              onClick={() => props.onMovePaneStep(menu.paneId, 1)}
            >
              <ChevronDownIcon />
              下へ移動
            </button>
            <button
              type="button"
              role="menuitem"
              class="hwc-menu-item"
              onClick={() => copyId(menu.paneId)}
            >
              <CopyGlyph copied={copied} />
              {copied ? "コピーしました" : "ペイン ID をコピー"}
            </button>
            <div class="hwc-menu-sep" />
            <button
              type="button"
              role="menuitem"
              class="hwc-menu-item hwc-menu-item--danger"
              onClick={() => {
                setClosing(menu.paneId);
                closeMenu();
              }}
            >
              <CloseIcon size={16} />
              ペインを閉じる
            </button>
          </div>
        </>
      ) : null}
      {closing ? (
        <Confirm
          title="ペインを閉じますか？"
          description={
            <>
              <span class="hwc-dialog-id">{closing}</span> を閉じます。開いていた作業は失われます。
            </>
          }
          confirmLabel="閉じる"
          onCancel={() => setClosing(null)}
          onConfirm={() => {
            props.onClosePane(closing);
            setClosing(null);
          }}
        />
      ) : null}
    </div>
  );
}
