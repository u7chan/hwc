import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AppState, PaneState, TabState } from "../../server/herdr/state";
import type { GitSync } from "../../shared/git";
import type { PullRequest } from "../../shared/pull-request";
import {
  AgentGlyphIcon,
  ChevronRightIcon,
  MergeIcon,
  MoreIcon,
  PaneIcon,
  RepoIcon,
} from "../icons";
import { DragGhost } from "../DragGhost";
import { GitCount } from "../GitCount";
import { MENU_ID } from "../Menu";
import {
  adjacentBeforeKey,
  dropBeforeId,
  isOrderChange,
  orderUnits,
  type OrderUnit,
} from "../order";
import { useOrderDrag } from "../order-drag";
import { ParentMark } from "../ParentMark";
import { agentPresence } from "../scope";
import {
  agentGlyph,
  countTabAgents,
  countWorkspaceAgents,
  countWorkspacePanes,
  groupMembers,
  groupWorkspaces,
  mostUrgentStatus,
  paneRowTitle,
  pullRequestTone,
  soleTab,
  type WorkspaceGroup,
} from "../select";
import { StatusLabel } from "../StatusLabel";
import { formatElapsed } from "../time";
import { spaceId } from "./active";
import { GroupAgents, GroupChildren, GroupSpaces, GroupStatus, WorkspaceGlyph } from "./groups";
import type { TreePaneListProps } from "./types";

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

export function TreePaneList(props: TreePaneListProps) {
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
          const slot = props.slots.indexOf(pane.id);
          return (
            // 狭い行の判定は、行そのものではなくこの枠の幅で行う。
            <li key={pane.id} class="hwc-pane-row">
              <div
                class="hwc-pane"
                data-pane-id={pane.id}
                data-current={pane.id === selectedPaneId}
                data-slot={slot >= 0 ? slot + 1 : undefined}
              >
                <button
                  type="button"
                  class="hwc-pane-open"
                  aria-current={pane.id === selectedPaneId ? "true" : undefined}
                  onPointerDown={(event) => props.onDragStart(event, pane.id)}
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
      {dragged === null ? null : <DragGhost label={dragged.label} />}
    </>
  );
}
