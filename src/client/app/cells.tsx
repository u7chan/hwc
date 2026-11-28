import type { ComponentChildren, RefObject } from "preact";
import type { ChatFile } from "../../server/chat/contract";
import type { AppState, PaneState } from "../../server/herdr/state";
import { messageFileLabel } from "../../shared/message-files";
import type { PaneProcess } from "../../shared/panes";
import { PaneDetail } from "../PaneDetail";
import { Preview } from "../Preview";
import { TabBar } from "../TabBar";
import type { PaneOutputHandle } from "../commands";
import type { ConfirmationAttempt } from "../confirmation";
import type { FileTreeIcons } from "../file-tree-display";
import type { FileTreeSide } from "../file-tree-side";
import { findPane, findPaneContext, type PaneContext } from "../select";
import { type DropZone, type SplitLeaf, type SplitNode, type TabSide } from "../split-view";
import { launchPhase, type PaneLaunch, type PaneLaunchView } from "../starting";
import { workingMs } from "../time";
import { tabRows, type TabRows } from "./tab-rows";
import type { DropTarget, OperationMenu, PreviewTarget } from "./types";

// セルの描画に要る、App が持っている状態。セルごとに変わらないものを 1 つにまとめ、
// App はこれを渡すだけにする。
export type CellContext = {
  // 一覧を出している間はまだ状態が無い。セルは状態が届いてから描く。
  state: AppState | null;
  compact: boolean;
  wide: boolean;
  focused: SplitLeaf | null;
  parentPaneIds: ReadonlySet<string>;
  menu: OperationMenu | null;
  menuPaneId: string | null;
  processes: ReadonlyMap<string, PaneProcess>;
  leavingPaneId: string | null;
  entering: string | null;
  dragging: { paneId: string; target: DropTarget | null } | null;
  detailStatus: ComponentChildren;
  // タブを外した直後の、ブラウザによる自動フォーカス移動を無視する目印。
  suppressFocusActivation: RefObject<boolean>;
  clearFocusSuppression: () => void;
  // 端末出力の ANSI 色を補正する基準。テーマの解決結果。
  scheme: "light" | "dark";
  treeSide: FileTreeSide;
  treeWidth: number;
  onTreeWidthChange: (width: number) => void;
  onTreeWidthCommit: (width: number) => void;
  treeIcons: FileTreeIcons;
  launches: ReadonlyMap<string, PaneLaunch>;
  now: number;
  workingSince: ReadonlyMap<string, number>;
  inputsInFlight: ReadonlySet<string>;
  dismissedConfirmations: Record<string, string>;
  confirmationAttempts: ReadonlyMap<string, ConfirmationAttempt>;
  // 一時タブのプレビュー。タブ列に出すかは inTab、本文も出ているかは previewing。
  preview: {
    target: PreviewTarget | null;
    inTab: boolean;
    previewing: boolean;
    leaf: SplitLeaf | null;
  };
};

// セルの中の操作。対象のペインは呼ぶ側が決める。
export type CellActions = {
  select: (paneId: string) => void;
  selectFromTab: (paneId: string) => void;
  removeFromTabs: (paneId: string) => void;
  finishTabLeave: (paneId: string) => void;
  showPreview: () => void;
  closePreview: () => void;
  back: (() => void) | null;
  startPaneDrag: (event: PointerEvent, paneId: string) => void;
  openPaneMenu: (paneId: string, trigger: HTMLElement) => void;
  openWorkspaceMenu: (workspaceId: string, trigger: HTMLElement) => void;
  send: (paneId: string, text: string, attachments: string[]) => Promise<boolean>;
  stop: (paneId: string) => Promise<boolean>;
  startAgent: (paneId: string) => void;
  createSpace: (paneId: string, path: string) => void;
  retryLaunch: (paneId: string) => void;
  useShell: (paneId: string) => void;
  openImage: (url: string, name: string) => void;
  openPreview: (paneId: string, file: ChatFile) => void;
  confirmFolderTrust: (paneId: string, id: string) => void;
  dismissConfirmation: (paneId: string, id: string) => void;
  outputRef: (paneId: string, handle: PaneOutputHandle | null) => void;
};

type CellProps = {
  leaf: SplitLeaf;
  parentDir: "row" | "col" | null;
  context: CellContext;
  actions: CellActions;
};

type CellTreeProps = {
  node: SplitNode;
  parentDir: "row" | "col" | null;
  context: CellContext;
  actions: CellActions;
};

const launchViewOf = (
  launch: PaneLaunch | null,
  item: PaneState,
  now: number,
): PaneLaunchView | null => {
  const phase = launchPhase(launch, item, now);
  if (launch === null || phase === null) return null;
  return {
    phase,
    agent: launch.agent,
    model: launch.model,
    effort: launch.effort,
    error: launch.request === "failed" ? launch.error : null,
  };
};

function PaneBody(props: {
  pane: PaneState;
  where: PaneContext;
  compact: boolean;
  current: boolean;
  context: CellContext;
  actions: CellActions;
}) {
  const { pane: item, where, compact, current, context, actions } = props;
  const { menu, menuPaneId, processes, launches, now, workingSince } = context;
  return (
    <PaneDetail
      key={item.id}
      pane={item}
      context={where}
      compact={compact}
      scheme={context.scheme}
      treeSide={context.treeSide}
      treeWidth={context.treeWidth}
      onTreeWidthChange={context.onTreeWidthChange}
      onTreeWidthCommit={context.onTreeWidthCommit}
      treeIcons={context.treeIcons}
      current={current}
      // 親ペインの印はセル見出しに出す。
      parentPaneIds={context.parentPaneIds}
      // セル見出しはブランチと作成元スペースだけを出す。名前はタブ列が言う。
      branch={where.branch}
      sync={where.sync}
      // PR を引く鍵はセルでも要る。表示用の sync とは別に渡し、分割表示のまま
      // push してもチップが引き直せるようにする。
      upstreamBranch={where.sync?.upstreamBranch ?? null}
      workspaceMenuOpen={
        menu?.open === true &&
        menu.target.kind === "workspace" &&
        menu.target.id === where.workspaceId
      }
      waitingMs={item.agentStatus === "working" ? workingMs(workingSince, item.id, now) : null}
      now={now}
      running={processes.get(item.id)?.running === true}
      sending={context.inputsInFlight.has(item.id)}
      launch={launchViewOf(launches.get(item.id) ?? null, item, now)}
      dismissedConfirmation={context.dismissedConfirmations[item.id] ?? null}
      confirmationAttempts={context.confirmationAttempts}
      onConfirmFolderTrust={(id) => actions.confirmFolderTrust(item.id, id)}
      onDismissConfirmation={(id) => actions.dismissConfirmation(item.id, id)}
      menuOpen={menu?.open === true && menu.listScope === null && menuPaneId === item.id}
      outputRef={(handle) => actions.outputRef(item.id, handle)}
      onOpenMenu={actions.openPaneMenu}
      onOpenWorkspaceMenu={actions.openWorkspaceMenu}
      onSubmit={(text, attachments) => actions.send(item.id, text, attachments)}
      onStop={() => actions.stop(item.id)}
      onStartAgent={() => actions.startAgent(item.id)}
      onCreateSpace={(path) => actions.createSpace(item.id, path)}
      onRetryLaunch={() => actions.retryLaunch(item.id)}
      onUseShell={() => actions.useShell(item.id)}
      onOpenImage={(url, name) => actions.openImage(url, name)}
      onOpenPreview={(file) => actions.openPreview(item.id, file)}
    />
  );
}

// フォーカスやドラッグの起点になる操作要素。セルの見出しのどこを掴んだかは、
// この要素の上かどうかで決める。DOM 構造に依存するので、文字列は 1 つに保つ。
const OPERABLE_ELEMENTS =
  "button, input, textarea, select, a[href], [contenteditable]:not([contenteditable='false'])";

// ドラッグ中のプレビューの文言。中央はセルの末尾への移動、端は分割。
const dropLabel = (zone: DropZone): string => {
  if (zone !== "center") {
    return { top: "上に追加", bottom: "下に追加", left: "左に追加", right: "右に追加" }[zone];
  }
  return "ここへ移動";
};

type CellTabsProps = {
  leaf: SplitLeaf;
  tabs: TabRows;
  focused: boolean;
  preview: { name: string; selected: boolean } | null;
  status: ComponentChildren;
  droppable: boolean;
  tabDrop: { pane: string; side: TabSide } | null;
  context: CellContext;
  actions: CellActions;
};

// タブ列の props の組み立て。セルとプレビューの 2 箇所で同じ値を渡すので、ここに 1 度だけ書く。
function CellTabs(props: CellTabsProps) {
  const { leaf, tabs, focused, preview, status, droppable, tabDrop, context, actions } = props;
  return (
    <TabBar
      leafId={leaf.id}
      tabs={tabs.rows}
      currentPaneId={leaf.active}
      focused={focused}
      multiSpace={tabs.multiSpace}
      parentPaneIds={context.parentPaneIds}
      processes={context.processes}
      preview={preview}
      status={status}
      leavingPaneId={context.leavingPaneId}
      droppable={droppable}
      onSelectPane={actions.selectFromTab}
      onRemoveTab={actions.removeFromTabs}
      onLeaveFinished={actions.finishTabLeave}
      onSelectPreview={actions.showPreview}
      onClosePreview={actions.closePreview}
      onBack={context.wide ? null : actions.back}
      onDragStart={actions.startPaneDrag}
      tabDrop={tabDrop}
    />
  );
}

// セルは木の葉。タブ列を上端に置き、active のペインを本文に出す。親の分割軸を
// data 属性に置き、ドラッグ中の向き判定に使う。
function Cell(props: CellProps) {
  const { leaf, parentDir, context, actions } = props;
  const { state, focused, compact, dragging, entering, preview } = context;
  if (state === null) return null;
  const item = findPane(state, leaf.active);
  if (item === null) return null;
  const where = findPaneContext(state, item.id);
  if (where === null) return null;
  const tabs = tabRows(state, leaf.tabs);
  const isCurrent = focused !== null && leaf === focused;
  const previewTab =
    preview.inTab && preview.target !== null && preview.leaf === leaf
      ? { name: messageFileLabel(preview.target.file.name), selected: preview.target.shown }
      : null;
  // クリックしたセルを current にする。Herdr のフォーカスに追従させると、
  // HWC から動かせないセルが current のままになる。
  const activate = () => {
    if (!isCurrent) actions.select(item.id);
  };
  // 見出しの focus() などプログラム的なフォーカスで current を動かさない。
  // 操作できる要素へフォーカスが入ったときだけ、そのセルを選ぶ。
  const activateFromFocus = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (context.suppressFocusActivation.current) {
      context.clearFocusSuppression();
      return;
    }
    if (target.closest(OPERABLE_ELEMENTS) === null) return;
    activate();
  };
  // ドラッグはセルの見出しからだけ始める。出力と入力の選択・操作を奪わない。
  const dragFromHead = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".hwc-pane-head") === null) return;
    if (target.closest(OPERABLE_ELEMENTS) !== null) return;
    actions.startPaneDrag(event, item.id);
  };
  const target =
    dragging?.target?.kind === "cell" && dragging.target.pane === item.id ? dragging.target : null;
  const tabDrop =
    dragging?.target?.kind === "tab" && leaf.tabs.includes(dragging.target.pane)
      ? { pane: dragging.target.pane, side: dragging.target.side }
      : null;
  return (
    <section
      class="hwc-split-cell"
      data-compact={compact}
      data-drop-pane={item.id}
      data-drop-parent={parentDir ?? undefined}
      data-flip-cell={leaf.id}
      data-split-enter={item.id === entering ? "true" : undefined}
      key={leaf.id}
      onPointerDown={(event) => {
        activate();
        dragFromHead(event);
      }}
      onFocusIn={activateFromFocus}
    >
      <CellTabs
        leaf={leaf}
        tabs={tabs}
        focused={isCurrent}
        preview={previewTab}
        status={context.wide ? null : context.detailStatus}
        droppable={!preview.previewing}
        tabDrop={tabDrop}
        context={context}
        actions={actions}
      />
      <div
        class="hwc-cell-body"
        data-leaving={context.leavingPaneId === item.id ? "true" : undefined}
      >
        <PaneBody
          pane={item}
          where={where}
          compact={compact}
          current={isCurrent}
          context={context}
          actions={actions}
        />
      </div>
      {target === null ? null : (
        <div class="hwc-drop" data-zone={target.zone} aria-hidden="true">
          <span>{dropLabel(target.zone)}</span>
        </div>
      )}
    </section>
  );
}

// 分割は再帰。子の親方向をそのまま渡し、端の向きを決める。広い画面は木の根を、
// 狭い画面は 1 枚の葉を渡す。呼ぶ側が同じ部品のままなので、画面幅をまたいでも
// 同じ位置のセルは作り直されない。
export function CellTree(props: CellTreeProps): ComponentChildren {
  const { node, parentDir, context, actions } = props;
  return node.kind === "leaf" ? (
    // セルの key は葉の識別子。木が組み直されても、同じ葉のままなら中身を作り直さない。
    <Cell key={node.id} leaf={node} parentDir={parentDir} context={context} actions={actions} />
  ) : (
    <div class="hwc-split" data-dir={node.dir}>
      {node.children.map((child) => (
        <CellTree node={child} parentDir={node.dir} context={context} actions={actions} />
      ))}
    </div>
  );
}

// プレビューは一時タブのまま。対象のペインがある葉のタブ列の末尾に 1 枚だけ出し、
// 本文だけをファイルの表示に差し替える。
export function PreviewCell(props: { context: CellContext; actions: CellActions }) {
  const { context, actions } = props;
  const { state, preview, focused } = context;
  const leaf = preview.leaf;
  const target = preview.target;
  if (state === null || leaf === null || target === null || !preview.previewing) return null;
  return (
    <>
      <CellTabs
        leaf={leaf}
        tabs={tabRows(state, leaf.tabs)}
        focused={leaf === focused}
        preview={{ name: messageFileLabel(target.file.name), selected: target.shown }}
        status={context.detailStatus}
        droppable={false}
        tabDrop={null}
        context={context}
        actions={actions}
      />
      <div class="hwc-detail-body">
        <Preview
          key={`${target.paneId}:${target.file.name}@${target.file.version}`}
          paneId={target.paneId}
          file={target.file}
          onClose={actions.closePreview}
        />
      </div>
    </>
  );
}
