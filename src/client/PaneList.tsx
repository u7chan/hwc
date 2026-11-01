import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AppState, WorktreeState } from "../server/herdr/state";
import {
  AgentGlyphIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyGlyph,
  MoreIcon,
  PaneIcon,
  RepoIcon,
  WorkspaceIcon,
  WorktreeIcon,
} from "./icons";
import { Confirm } from "./Confirm";
import { agentGlyph, countPanes, countWorkspacePanes } from "./select";
import { formatElapsed } from "./time";
import { StatusLabel } from "./StatusLabel";

type PaneListProps = {
  state: AppState;
  selectedPaneId: string | null;
  expanded: Set<string>;
  onSelect: (paneId: string) => void;
  onToggle: (groupId: string) => void;
  onClosePane: (paneId: string) => void;
  onDropPane: (paneId: string, targetPaneId: string, after: boolean) => void;
  workingSince: ReadonlyMap<string, number>;
  now: number;
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
  const [closing, setClosing] = useState<string | null>(null);
  // ドラッグは PC の操作。触れる画面では発火しないので、そのまま置いておく。
  const positions = useRef<Map<string, number>>(new Map());
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ paneId: string; after: boolean } | null>(null);

  // 並びが変わったら、前の位置から今の位置まで滑らせる（FLIP）。
  useLayoutEffect(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".hwc-pane[data-pane-id]")];
    const next = new Map<string, number>();
    const animate =
      typeof window !== "undefined" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    for (const row of rows) {
      const id = row.dataset.paneId;
      if (!id) continue;
      const top = row.getBoundingClientRect().top;
      next.set(id, top);
      const before = positions.current.get(id);
      if (!animate || before === undefined || Math.abs(before - top) < 1) continue;

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
  const { state, selectedPaneId, expanded, onSelect, onToggle, onClosePane, workingSince, now } =
    props;

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
                {panes.map(({ pane, tabLabel }) => {
                  const startedAt = workingSince.get(pane.id);
                  return (
                    <li key={pane.id}>
                      <div
                        class="hwc-pane"
                        data-pane-id={pane.id}
                        data-current={pane.id === selectedPaneId}
                        data-dragging={dragged === pane.id}
                        data-drop={
                          dropAt?.paneId === pane.id
                            ? dropAt.after
                              ? "after"
                              : "before"
                            : undefined
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
                          const after = dropAt?.after ?? false;
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
                            <span class="hwc-pane-sub">{tabLabel}</span>
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
            onClosePane(closing);
            setClosing(null);
          }}
        />
      ) : null}
    </div>
  );
}
