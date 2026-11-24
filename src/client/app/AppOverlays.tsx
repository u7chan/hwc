import type { StateUpdater } from "preact/hooks";
import type { PaneState, WorkspaceState } from "../../server/herdr/state";
import { MAX_PANES_PER_TAB } from "../../shared/panes";
import type { paneCloseAction } from "../../shared/pane-close";
import type { PullRequest } from "../../shared/pull-request";
import type { GitSyncFailure } from "../requests/workspaces";
import { CloseConfirm } from "../CloseConfirm";
import { CloseSpaceConfirm } from "../CloseSpaceConfirm";
import { CreatePane } from "../CreatePane";
import { DragGhost } from "../DragGhost";
import { ArrowUpIcon, ChevronRightIcon, GitHubIcon, PlusIcon, TrashIcon } from "../icons";
import { ImageViewer } from "../ImageViewer";
import { Menu } from "../Menu";
import { PaneMenu } from "../PaneMenu";
import { RemoveWorktreeConfirm } from "../RemoveWorktreeConfirm";
import type { PaneRow } from "../select";
import type { LaunchIntent } from "../starting";
import { WorkspaceGitActions } from "../WorkspaceGitActions";
import { WorkspaceMenuHead } from "../WorkspaceMenuHead";
import type {
  Closing,
  ClosingSpace,
  CreatingPane,
  DropTarget,
  OperationMenu,
  Removing,
  RemovingPhase,
} from "./types";
import type { ConfirmFlow } from "./hooks/use-confirm-flow";

export type AppOverlaysProps = {
  dragging: { paneId: string; target: DropTarget | null } | null;
  draggingLabel: string;
  menu: OperationMenu | null;
  menuPane: PaneState | null;
  menuWorkspace: WorkspaceState | null;
  menuPaneId: string | null;
  menuRow: PaneRow | null;
  menuFull: boolean;
  menuCloseAction: ReturnType<typeof paneCloseAction>;
  menuPullRequest: PullRequest | null;
  menuRepoUrl: string | null;
  menuGitBusy: "fetch" | "pull" | null;
  menuGitFailed: { action: "fetch" | "pull"; error: GitSyncFailure } | null;
  menuCanCloseSpace: boolean;
  menuCanMoveToTop: boolean;
  canCreateWorktree: boolean;
  dismissMenu: () => void;
  closeMenu: () => void;
  setMenu: (value: StateUpdater<OperationMenu | null>) => void;
  openCreateDialog: (paneId: string) => void;
  clearOutputForMenu: (paneId: string) => Promise<boolean>;
  openCloseConfirm: () => void;
  openCreateWorktreeDialog: () => void;
  openRemoveWorktreeConfirm: () => void;
  openCloseSpaceConfirm: () => void;
  moveWorkspaceToTop: () => void;
  runGitSync: (workspaceId: string, action: "fetch" | "pull") => Promise<void>;
  closing: ConfirmFlow<Closing>;
  closingPane: PaneState | null;
  removing: ConfirmFlow<Removing, RemovingPhase>;
  removingWorkspace: WorkspaceState | null;
  closingSpace: ConfirmFlow<ClosingSpace>;
  creating: CreatingPane | null;
  setCreating: (value: CreatingPane | null) => void;
  setPendingSelect: (value: string | null) => void;
  beginLaunch: (paneId: string, intent: LaunchIntent | null) => void;
  viewer: { url: string; name: string } | null;
  setViewer: (value: { url: string; name: string } | null) => void;
};

export function AppOverlays(props: AppOverlaysProps) {
  const {
    dragging,
    draggingLabel,
    menu,
    menuPane,
    menuWorkspace,
    menuPaneId,
    menuRow,
    menuFull,
    menuCloseAction,
    menuPullRequest,
    menuRepoUrl,
    menuGitBusy,
    menuGitFailed,
    menuCanCloseSpace,
    menuCanMoveToTop,
    canCreateWorktree,
    dismissMenu,
    closeMenu,
    setMenu,
    openCreateDialog,
    clearOutputForMenu,
    openCloseConfirm,
    openCreateWorktreeDialog,
    openRemoveWorktreeConfirm,
    openCloseSpaceConfirm,
    moveWorkspaceToTop,
    runGitSync,
    closing,
    closingPane,
    removing,
    removingWorkspace,
    closingSpace,
    creating,
    setCreating,
    setPendingSelect,
    beginLaunch,
    viewer,
    setViewer,
  } = props;

  return (
    <>
      {dragging === null ? null : <DragGhost label={draggingLabel} />}

      {menu === null || (menuPane === null && menuWorkspace === null) ? null : (
        <Menu
          key={`${menu.target.kind}:${menu.target.id}`}
          label={`${menuWorkspace?.label ?? menuPaneId} の操作`}
          trigger={menu.trigger}
          open={menu.open}
          onClose={dismissMenu}
          onExited={() => setMenu((current) => (current?.open === false ? null : current))}
          closeOnScroll={menu.fromList}
        >
          {menuPane === null ? null : (
            <PaneMenu
              pane={menuPane}
              workspacePath={menuRow?.workspace.path ?? null}
              full={menuFull}
              closeAction={menuCloseAction}
              onCreate={() => openCreateDialog(menuPane.id)}
              onClearOutput={() => clearOutputForMenu(menuPane.id)}
              onClosePane={openCloseConfirm}
              onDismiss={closeMenu}
            />
          )}
          {menuWorkspace === null ? null : (
            <>
              <WorkspaceMenuHead label={menuWorkspace.label} path={menuWorkspace.path ?? null} />
              {menuWorkspace.tabs.map((tab) => {
                const source = tab.panes[0];
                const full = tab.panes.length >= MAX_PANES_PER_TAB;
                return (
                  <div key={tab.id}>
                    <button
                      type="button"
                      role="menuitem"
                      class="hwc-menu-item"
                      disabled={full || source === undefined}
                      onClick={() => source && openCreateDialog(source.id)}
                    >
                      <PlusIcon size={14} />
                      {menuWorkspace.tabs.length === 1
                        ? "新しいペイン"
                        : `${tab.label || tab.id} に新しいペイン`}
                    </button>
                    {full ? <p class="hwc-menu-note">このタブは 4 ペインまで</p> : null}
                  </div>
                );
              })}
              {menuPullRequest === null && menuRepoUrl === null ? null : (
                <>
                  <hr class="hwc-menu-separator" />
                  {menuRepoUrl === null ? null : (
                    <a
                      class="hwc-menu-item"
                      role="menuitem"
                      href={menuRepoUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={closeMenu}
                    >
                      <GitHubIcon size={14} />
                      リポジトリを GitHub で開く
                    </a>
                  )}
                  {menuPullRequest === null ? null : (
                    <a
                      class="hwc-menu-item"
                      role="menuitem"
                      href={menuPullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={closeMenu}
                    >
                      <ChevronRightIcon size={14} />
                      PR #{menuPullRequest.number} を開く
                    </a>
                  )}
                </>
              )}
              <WorkspaceGitActions
                sync={menuWorkspace.sync ?? null}
                busy={menuGitBusy}
                failed={menuGitFailed}
                onRun={(action) => void runGitSync(menuWorkspace.id, action)}
              />
              {menuCanMoveToTop ? (
                <>
                  <hr class="hwc-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    class="hwc-menu-item"
                    onClick={moveWorkspaceToTop}
                  >
                    <ArrowUpIcon size={14} />
                    先頭へ移動
                  </button>
                </>
              ) : null}
              {canCreateWorktree ? (
                <>
                  <hr class="hwc-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    class="hwc-menu-item"
                    onClick={openCreateWorktreeDialog}
                  >
                    <PlusIcon size={14} />
                    新しいワークツリー
                  </button>
                </>
              ) : null}
              {menuWorkspace.worktree?.managed === true &&
              menuWorkspace.worktree.isLinkedWorktree ? (
                <>
                  <hr class="hwc-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    class="hwc-menu-item hwc-menu-item--danger"
                    onClick={openRemoveWorktreeConfirm}
                  >
                    <TrashIcon size={14} />
                    ワークツリーを削除
                  </button>
                </>
              ) : null}
              {menuCanCloseSpace ? (
                <>
                  <hr class="hwc-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    class="hwc-menu-item hwc-menu-item--danger"
                    onClick={openCloseSpaceConfirm}
                  >
                    <TrashIcon size={14} />
                    スペースを閉じる
                  </button>
                </>
              ) : null}
            </>
          )}
        </Menu>
      )}

      {closing.state === null || closingPane === null ? null : (
        <CloseConfirm
          pane={closingPane}
          action={closing.state.target.action}
          available={closing.available}
          busy={closing.state.phase === "busy"}
          failed={closing.state.phase === "failed"}
          onConfirm={closing.confirm}
          onCancel={closing.cancel}
        />
      )}

      {removing.state === null ||
      removing.state.phase === "leave" ||
      removingWorkspace === null ? null : (
        <RemoveWorktreeConfirm
          label={removing.state.target.label}
          checkoutPath={removing.state.target.checkoutPath}
          available={removing.available}
          busy={removing.state.phase === "busy"}
          failed={removing.state.phase === "failed"}
          onConfirm={removing.confirm}
          onCancel={removing.cancel}
        />
      )}

      {closingSpace.state === null ? null : (
        <CloseSpaceConfirm
          label={closingSpace.state.target.label}
          path={closingSpace.state.target.path}
          available={closingSpace.available}
          busy={closingSpace.state.phase === "busy"}
          failed={closingSpace.state.phase === "failed"}
          onConfirm={closingSpace.confirm}
          onCancel={closingSpace.cancel}
        />
      )}

      {creating === null ? null : (
        <CreatePane
          paneId={creating.paneId}
          target={creating.target}
          onCreated={(paneId, launch) => {
            setPendingSelect(paneId);
            beginLaunch(paneId, launch);
          }}
          onClose={() => setCreating(null)}
        />
      )}

      {viewer === null ? null : (
        <ImageViewer url={viewer.url} name={viewer.name} onClose={() => setViewer(null)} />
      )}
    </>
  );
}
