import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { AppState, WorktreeState } from "../server/herdr/state";
import {
  AgentGlyphIcon,
  ChevronRightIcon,
  CopyIcon,
  MoreIcon,
  PaneIcon,
  RepoIcon,
  WorkspaceIcon,
  WorktreeIcon,
} from "./icons";
import { agentGlyph, countPanes, countWorkspacePanes } from "./select";
import { StatusLabel } from "./StatusLabel";

type PaneListProps = {
  state: AppState;
  selectedPaneId: string | null;
  expanded: Set<string>;
  onSelect: (paneId: string) => void;
  onToggle: (groupId: string) => void;
};

// git 管理下でない / 通常のリポジトリ / linked worktree を形で見分ける。
function WorkspaceGlyph({ worktree }: { worktree: WorktreeState | null }) {
  if (!worktree) return <WorkspaceIcon />;
  return worktree.isLinkedWorktree ? <WorktreeIcon /> : <RepoIcon />;
}

function WorkspaceRow(props: {
  label: string;
  worktree: WorktreeState | null;
  count: number;
  status: ComponentChildren;
  expanded: boolean;
  controlsId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      class="hwc-group"
      aria-expanded={props.expanded}
      aria-controls={props.controlsId}
      onClick={props.onToggle}
    >
      <span class="hwc-group-icon">
        <WorkspaceGlyph worktree={props.worktree} />
      </span>
      <span class="hwc-group-main">
        <span class="hwc-group-name">{props.label}</span>
        <span class="hwc-group-sub">{props.count} ペイン</span>
      </span>
      {props.status}
      <span class="hwc-chevron" data-open={props.expanded}>
        <ChevronRightIcon />
      </span>
    </button>
  );
}

// 高さを 0fr → 1fr で動かすため、閉じていても中身は描画したままにする。
function GroupChildren(props: { id: string; open: boolean; children: ComponentChildren }) {
  return (
    <div id={props.id} class="hwc-group-children" data-open={props.open}>
      <div class="hwc-children-inner">{props.children}</div>
    </div>
  );
}

export function PaneList(props: PaneListProps) {
  // メニューは行の中に置くと一覧のスクロールで切れる。画面に固定して出す。
  const [menu, setMenu] = useState<{ paneId: string; top: number; right: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const openMenu = (event: MouseEvent, paneId: string) => {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    setCopied(false);
    // 画面の下で切れないように、はみ出す分だけ上へ寄せる。
    const height = 150;
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
  const { state, selectedPaneId, expanded, onSelect, onToggle } = props;

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
    <div class="hwc-list-scroll">
      {state.workspaces.map((workspace) => {
        const open = expanded.has(workspace.id);
        const groupId = `hwc-group-${workspace.id}`;
        const panes = workspace.tabs.flatMap((tab) =>
          tab.panes.map((pane) => ({ pane, tabLabel: tab.label })),
        );
        return (
          <section class="hwc-group-block" key={workspace.id}>
            <WorkspaceRow
              label={workspace.label}
              worktree={workspace.worktree}
              count={countWorkspacePanes(workspace.id, state)}
              // 開いているときは各ペインの状態が見えるので、まとめの状態は消す。
              // 位置がずれないように、消すときも場所は残して透明度だけ落とす。
              status={
                <span class="hwc-group-status" data-hidden={open}>
                  <StatusLabel status={workspace.agentStatus} />
                </span>
              }
              expanded={open}
              controlsId={groupId}
              onToggle={() => onToggle(workspace.id)}
            />
            <GroupChildren id={groupId} open={open}>
              <ul class="hwc-panes">
                {panes.map(({ pane, tabLabel }) => (
                  <li key={pane.id}>
                    <div class="hwc-pane" data-current={pane.id === selectedPaneId}>
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
                          <span class="hwc-pane-sub">{tabLabel}</span>
                        </span>
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
                ))}
              </ul>
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
              onClick={() => {
                onSelect(menu.paneId);
                closeMenu();
              }}
            >
              <ChevronRightIcon />
              ペインを開く
            </button>
            <button
              type="button"
              role="menuitem"
              class="hwc-menu-item"
              onClick={() => copyId(menu.paneId)}
            >
              <CopyIcon />
              {copied ? "コピーしました" : "ペイン ID をコピー"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
