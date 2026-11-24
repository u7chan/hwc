import type { PaneState, WorkspaceState } from "../../server/herdr/state";
import { MAX_PANES_PER_TAB } from "../../shared/panes";
import { CloseConfirm } from "../CloseConfirm";
import { CloseSpaceConfirm } from "../CloseSpaceConfirm";
import { CreatePane } from "../CreatePane";
import { DragGhost } from "../DragGhost";
import { ArrowUpIcon, ChevronRightIcon, GitHubIcon, PlusIcon, TrashIcon } from "../icons";
import { ImageViewer } from "../ImageViewer";
import { Menu } from "../Menu";
import { PaneMenu } from "../PaneMenu";
import { RemoveWorktreeConfirm } from "../RemoveWorktreeConfirm";
import type { LaunchIntent } from "../starting";
import { WorkspaceGitActions } from "../WorkspaceGitActions";
import { WorkspaceMenuHead } from "../WorkspaceMenuHead";
import type { MenuView } from "./menu";
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

// メニューの中身と、その項目が呼ぶ操作。開いていなければ operation が null。
export type MenuOverlay = MenuView & {
  operation: OperationMenu | null;
  dismiss: () => void;
  close: () => void;
  // 閉じるアニメーションが終わったメニューを落とす。
  exited: () => void;
  openCreate: (paneId: string) => void;
  clearOutput: (paneId: string) => Promise<boolean>;
  openCloseConfirm: () => void;
  openCreateWorktree: () => void;
  openRemoveWorktree: () => void;
  openCloseSpace: () => void;
  moveToTop: () => void;
  runGitSync: (workspaceId: string, action: "fetch" | "pull") => Promise<void>;
};

// 確認はどれも、フロー（送信中・失敗の表示）と対象の表示名だけを渡す。
export type ClosingOverlay = { flow: ConfirmFlow<Closing>; pane: PaneState | null };

export type RemovingOverlay = {
  flow: ConfirmFlow<Removing, RemovingPhase>;
  workspace: WorkspaceState | null;
};

export type ClosingSpaceOverlay = { flow: ConfirmFlow<ClosingSpace> };

export type AppOverlaysProps = {
  dragging: { paneId: string; target: DropTarget | null } | null;
  draggingLabel: string;
  menu: MenuOverlay;
  closing: ClosingOverlay;
  removing: RemovingOverlay;
  closingSpace: ClosingSpaceOverlay;
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
    closing,
    removing,
    closingSpace,
    creating,
    setCreating,
    setPendingSelect,
    beginLaunch,
    viewer,
    setViewer,
  } = props;
  const { operation, pane: menuPane, workspace: menuWorkspace } = menu;
  const { flow: closingFlow, pane: closingPane } = closing;
  const { flow: removingFlow, workspace: removingWorkspace } = removing;
  const closingSpaceFlow = closingSpace.flow;

  return (
    <>
      {dragging === null ? null : <DragGhost label={draggingLabel} />}

      {operation === null || (menuPane === null && menuWorkspace === null) ? null : (
        <Menu
          key={`${operation.target.kind}:${operation.target.id}`}
          label={`${menuWorkspace?.label ?? menu.paneId} の操作`}
          trigger={operation.trigger}
          open={operation.open}
          onClose={menu.dismiss}
          onExited={menu.exited}
          closeOnScroll={operation.fromList}
        >
          {menuPane === null ? null : (
            <PaneMenu
              pane={menuPane}
              workspacePath={menu.row?.workspace.path ?? null}
              full={menu.full}
              closeAction={menu.closeAction}
              onCreate={() => menu.openCreate(menuPane.id)}
              onClearOutput={() => menu.clearOutput(menuPane.id)}
              onClosePane={menu.openCloseConfirm}
              onDismiss={menu.close}
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
                      onClick={() => source && menu.openCreate(source.id)}
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
              {menu.pullRequest === null && menu.repoUrl === null ? null : (
                <>
                  <hr class="hwc-menu-separator" />
                  {menu.repoUrl === null ? null : (
                    <a
                      class="hwc-menu-item"
                      role="menuitem"
                      href={menu.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={menu.close}
                    >
                      <GitHubIcon size={14} />
                      リポジトリを GitHub で開く
                    </a>
                  )}
                  {menu.pullRequest === null ? null : (
                    <a
                      class="hwc-menu-item"
                      role="menuitem"
                      href={menu.pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={menu.close}
                    >
                      <ChevronRightIcon size={14} />
                      PR #{menu.pullRequest.number} を開く
                    </a>
                  )}
                </>
              )}
              <WorkspaceGitActions
                sync={menuWorkspace.sync ?? null}
                busy={menu.gitBusy}
                failed={menu.gitFailed}
                onRun={(action) => void menu.runGitSync(menuWorkspace.id, action)}
              />
              {menu.canMoveToTop ? (
                <>
                  <hr class="hwc-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    class="hwc-menu-item"
                    onClick={menu.moveToTop}
                  >
                    <ArrowUpIcon size={14} />
                    先頭へ移動
                  </button>
                </>
              ) : null}
              {menu.canCreateWorktree ? (
                <>
                  <hr class="hwc-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    class="hwc-menu-item"
                    onClick={menu.openCreateWorktree}
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
                    onClick={menu.openRemoveWorktree}
                  >
                    <TrashIcon size={14} />
                    ワークツリーを削除
                  </button>
                </>
              ) : null}
              {menu.canCloseSpace ? (
                <>
                  <hr class="hwc-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    class="hwc-menu-item hwc-menu-item--danger"
                    onClick={menu.openCloseSpace}
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

      {closingFlow.state === null || closingPane === null ? null : (
        <CloseConfirm
          pane={closingPane}
          action={closingFlow.state.target.action}
          available={closingFlow.available}
          busy={closingFlow.state.phase === "busy"}
          failed={closingFlow.state.phase === "failed"}
          onConfirm={closingFlow.confirm}
          onCancel={closingFlow.cancel}
        />
      )}

      {removingFlow.state === null ||
      removingFlow.state.phase === "leave" ||
      removingWorkspace === null ? null : (
        <RemoveWorktreeConfirm
          label={removingFlow.state.target.label}
          checkoutPath={removingFlow.state.target.checkoutPath}
          available={removingFlow.available}
          busy={removingFlow.state.phase === "busy"}
          failed={removingFlow.state.phase === "failed"}
          onConfirm={removingFlow.confirm}
          onCancel={removingFlow.cancel}
        />
      )}

      {closingSpaceFlow.state === null ? null : (
        <CloseSpaceConfirm
          label={closingSpaceFlow.state.target.label}
          path={closingSpaceFlow.state.target.path}
          available={closingSpaceFlow.available}
          busy={closingSpaceFlow.state.phase === "busy"}
          failed={closingSpaceFlow.state.phase === "failed"}
          onConfirm={closingSpaceFlow.confirm}
          onCancel={closingSpaceFlow.cancel}
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
