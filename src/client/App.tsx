import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import type { AppState, PaneState } from "../server/herdr/state";
import { messageFileLabel } from "../shared/message-files";
import { PaneDetail } from "./PaneDetail";
import { attachmentStore } from "./attachment-store";
import { fileTreeFontSize, fileTreeWidthPx } from "./file-tree-display";
import { fileTreeStore } from "./file-tree-store";
import { TabBar } from "./TabBar";
import { PaneList } from "./PaneList";
import { Settings } from "./settings/Settings";
import type {
  Closing,
  ClosingSpace,
  CreatingPane,
  DropTarget,
  GitAction,
  LeavingTab,
  OperationMenu,
  Removing,
  View,
} from "./app/types";
import { useFlipLayout } from "./app/use-flip-layout";
import { useMediaQuery } from "./app/use-media-query";
import { usePaneDrag } from "./app/use-pane-drag";
import { usePreview } from "./app/use-preview";
import { defaultView } from "./app/default-view";
import { toTimes } from "./app/times";
import { FooterBrand, ListPlaceholder, Placeholder } from "./app/Placeholders";
import { AppOverlays, type AppOverlaysProps } from "./app/AppOverlays";
import { useFavicon } from "./app/hooks/use-favicon";
import { useFileTreeDisplay } from "./app/hooks/use-file-tree-display";
import { useFileTreeSide } from "./app/hooks/use-file-tree-side";
import { useListScope } from "./app/hooks/use-list-scope";
import { useLiveUpdate } from "./app/hooks/use-live-update";
import { useLiveUpdateTick } from "./app/hooks/use-live-update-tick";
import { useOpenGroups } from "./app/hooks/use-open-groups";
import { useRevision } from "./app/hooks/use-revision";
import { useServerClock } from "./app/hooks/use-server-clock";
import { useSidebarCollapsed } from "./app/hooks/use-sidebar-collapsed";
import { useSidebarWidth } from "./app/hooks/use-sidebar-width";
import { useSplitPreference } from "./app/hooks/use-split-preference";
import { useThemePreference } from "./app/hooks/use-theme-preference";
import {
  fetchState,
  focusAgent,
  clearPaneOutput,
  closePane,
  closeWorkspace,
  confirmFolderTrust,
  moveWorkspaceBlock,
  parseAppState,
  removeWorktree,
  sendInput,
  startAgent,
  stopAgent,
  syncWorkspace,
} from "./api";
import { INITIAL_CONNECTION, connectionAfter, type ConnectionStatus } from "./connection";
import { liveUpdateMs } from "./live-update";
import { allAgentPaneIds, allPaneIds, applyDelegation, newAgentPanes } from "./delegation";
import { splitMotionDuration } from "./split-prefs";
import { ConnectionChip } from "./ConnectionChip";
import { Preview } from "./Preview";
import { ChevronLeftIcon, HwcMark, SettingsIcon } from "./icons";
import { paneTabName, usePaneProcesses } from "./process";
import { useWorkspacePullRequests } from "./pull-request";
import type { PaneOutputHandle } from "./commands";
import type { ConfirmationAttempt } from "./confirmation";
import { MAX_PANES_PER_TAB } from "../shared/panes";
import { paneCloseAction } from "../shared/pane-close";
import {
  activeRowName,
  canCloseSpace,
  findPane,
  findPaneContext,
  findPaneRow,
  groupWorkspaces,
  markedParentPaneIds,
  shortenSpaceName,
  tabDisplayName,
  tabLabel,
  tabLabelText,
  type PaneContext,
} from "./select";
import {
  defaultPaneOf,
  expandForWorkspace,
  revealPane,
  revealPaneGroups,
  workspaceGroupIds,
  writeSplitView,
} from "./selection";
import {
  EMPTY_SPLIT_VIEW,
  clearCurrent,
  dropOnPane,
  leafPanes,
  moveTab,
  multiSpace,
  nextTabPane,
  openPane,
  readingOrder,
  removeTab,
  syncSplitView,
  tabDropMode,
  tabPanes,
  type DropZone,
  type SplitNode,
  type SplitView,
} from "./split-view";
import { pendingReadAfter, shouldFocusOnLeave, type ListScope } from "./scope";
import { moveToTopPlan, orderUnits } from "./order";
import { gateSnapshot, type SnapshotOrigin } from "./snapshot";
import { type LaunchIntent, type PaneLaunch, type PaneLaunchView, launchPhase } from "./starting";
import { serverClockNow, workingMs } from "./time";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_STEP,
  WIDE_LAYOUT_QUERY,
  clampSidebarWidth,
} from "./layout";

const NO_GROUPS: ReadonlySet<string> = new Set();
// スロット色を出さないときの並び。狭い画面は 4 色を使わない。
const NO_SLOTS: readonly string[] = [];

const NO_PARENT_PANE_IDS: ReadonlySet<string> = new Set();

// 一覧の行が消えるアニメーション（PaneList）の完了が届かない場合の保険。
// 待っている間も他の表示は止まるので、アニメーションより少し長い程度に留める。
const REMOVAL_LEAVE_FALLBACK_MS = 800;

// タブのアニメーションの完了が届かない場合の保険。SSE の適用もこの間だけ遅らせる。
const TAB_LEAVE_FALLBACK_MS = 400;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  // 一覧の見出しに出す最新の PR。ペイン見出しのチップとは別に、表示中の一覧ぶんをまとめて持つ。
  const pullRequests = useWorkspacePullRequests(state);
  const [connection, setConnection] = useState<ConnectionStatus>(INITIAL_CONNECTION);
  // 利用者が選んだ・開いた結果だけを持つ。まだ触っていない間はスナップショットから導く。
  const [view, setView] = useState<View | null>(null);
  const initialView = useRef<View | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dismissedConfirmations, setDismissedConfirmations] = useState<Record<string, string>>({});
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  // 最新の木をイベントから引く。ドラッグの購読は 1 度しか張らない。
  const splitRef = useRef<SplitView>(EMPTY_SPLIT_VIEW);
  // SSE の購読は 1 度しか張らないので、タブを外したあとの反映に使う一覧の
  // 開閉状態も ref から読む。
  const expandedRef = useRef<ReadonlySet<string>>(NO_GROUPS);
  const { openGroups, rememberOpen } = useOpenGroups();
  // 帯から「すべて」の場所へ移ったとき、一覧をその見出しまで送るための要求。
  // 同じ場所を何度も開けるよう、token で 1 回ずつ処理する。
  const [reveal, setReveal] = useState<{ workspaceId: string; token: number } | null>(null);
  const revealSeq = useRef(0);
  // 作ったばかりのペインを一覧で見せる要求。狭い画面は詳細を開いている間、一覧が
  // display:none でスクロールできないので、一覧が見えるまでペイン id だけ預かる。
  const [createdPane, setCreatedPane] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{
    paneId: string;
    scope: ListScope;
    token: number;
  } | null>(null);
  const scrollToSeq = useRef(0);
  // メニューの「先頭へ移動」。一覧がアニメーションを 1 度だけ起こせるよう、token で示す。
  const [moveToTop, setMoveToTop] = useState<{ workspaceId: string; token: number } | null>(null);
  const moveToTopSeq = useRef(0);
  const { scope, changeScope } = useListScope(() => setReveal(null));
  // メニューと確認はセルの外（App 直下）に 1 つだけ出す。セルは container-type を持ち、
  // 内側の fixed はセル基準になる。同時には 1 つだけ出し、Esc の購読を重ねない。
  const [menu, setMenu] = useState<OperationMenu | null>(null);
  const [gitAction, setGitAction] = useState<GitAction | null>(null);
  const gitActionInFlight = useRef(false);
  // クリア後の読み直しのために、表示中の詳細への実行口を預かる。
  const outputHandles = useRef(new Map<string, PaneOutputHandle>());
  // メニューや詳細の寿命でロックを失わず、次の描画より前の連打も抑える。
  // 正はこの集合だけにし、描画には変更通知を使う。
  const inputsInFlight = useRef(new Set<string>());
  const [, inputChanged] = useReducer((revision: number) => revision + 1, 0);
  // 結果不明の回答は再送できない。詳細の付け外しを越えて、この Map だけに試行状態を残す。
  const confirmationAttempts = useRef(new Map<string, ConfirmationAttempt>());
  const [, confirmationChanged] = useReducer((revision: number) => revision + 1, 0);
  const [closing, setClosing] = useState<Closing | null>(null);
  const closingRef = useRef<Closing | null>(null);
  closingRef.current = closing;
  const [leavingTab, setLeavingTab] = useState<LeavingTab | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [closingSpace, setClosingSpace] = useState<ClosingSpace | null>(null);
  const [creating, setCreating] = useState<CreatingPane | null>(null);
  // 拡大中の画像。ダイアログは App 直下。
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);
  // 応答で受け取った新ペインは、スナップショットに現れてから開く。先に選ぶと一覧が一瞬出る。
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  // 起動を頼んだペイン。ダイアログで選んだ内容だけを持ち、起動したかはスナップショットで決める。
  // 起動が終わるまでに別のペインも作れるので、ペイン id ごとに持つ。
  const [launches, setLaunches] = useState<ReadonlyMap<string, PaneLaunch>>(() => new Map());
  // 要求済みの記録。再試行で記録が置き換わっても、前の要求の完了が新しい要求の
  // 番人を消さないよう、ペイン id ではなく記録そのもので覚える。
  const launchRequests = useRef(new Set<PaneLaunch>());
  const closeInFlight = useRef(false);
  const removeInFlight = useRef(false);
  const closeSpaceInFlight = useRef(false);
  // 既読の保留。アクティブ一覧で開いたペインだけが入り、選択が離れた時点で判定する。
  const pendingRead = useRef<string | null>(null);
  // 削除対象が消えたスナップショットは、一覧の行が消えるアニメーションが終わるまで
  // 1 回だけ保留する。正は BFF のままで、描画のタイミングだけをずらす。
  const removingRef = useRef<Removing | null>(null);
  removingRef.current = removing;
  // 外すタブのアニメーション中も、スナップショットの適用を 1 回だけ保留する。
  const leavingTabRef = useRef<LeavingTab | null>(null);
  leavingTabRef.current = leavingTab;
  const leaveTabTimer = useRef<number | null>(null);
  const heldSnapshot = useRef<AppState | null>(null);
  const heldSnapshotTimer = useRef<number | null>(null);

  // 状態の書き込み元は 1 つ。初回の fetch は SSE が最初のスナップショットを届けるまでの
  // つなぎで、届いた後は捨てる（遅れて返った古い応答で上書きしない）。
  const snapshotWriter = useRef<SnapshotOrigin>("initial-fetch");
  const { now, skew, receive } = useServerClock();

  // 消える行のアニメーションが終わったら、保留したスナップショットを適用する。
  const finishRemoval = () => {
    if (heldSnapshotTimer.current !== null) {
      window.clearTimeout(heldSnapshotTimer.current);
      heldSnapshotTimer.current = null;
    }
    setRemoving((current) => (current?.phase === "leave" ? null : current));
  };

  // 削除が確定したらダイアログを閉じ、一覧の対象を消えるアニメーションへ渡す。
  const beginRemovalLeave = () => {
    setRemoving((current) => (current === null ? null : { ...current, phase: "leave" }));
    heldSnapshotTimer.current ??= window.setTimeout(finishRemoval, REMOVAL_LEAVE_FALLBACK_MS);
  };

  // 受信したスナップショットで丸ごと置き換える（docs/adr/bff-client-transport.md）。画面から消える対象の
  // アニメーションが途中で切り落とされないよう、その間だけ適用を保留する。
  const applyState = (next: AppState) => {
    const target = removingRef.current;
    if (target?.phase === "leave" || leavingTabRef.current !== null) {
      heldSnapshot.current = next;
      return;
    }
    // 応答より先にスペースが消えたスナップショットが届くことがある。対象を消して
    // 見せてから適用する。
    if (
      target?.phase === "busy" &&
      !next.workspaces.some((workspace) => workspace.id === target.workspaceId)
    ) {
      heldSnapshot.current = next;
      beginRemovalLeave();
      return;
    }
    // ペインを閉じる要求の応答より先に、ペインが消えたスナップショットが届くことが
    // ある。消えるタブを先に見せてから適用する。ペインが無い以上 close の目的は
    // 達しているので、確認は閉じ、遅れて返る応答は捨てる。
    const closeTarget = closingRef.current;
    if (
      closeTarget?.phase === "busy" &&
      closeTarget.action === "close" &&
      findPane(next, closeTarget.paneId) === null
    ) {
      // タブとして開いていないペインはアニメーションできない。保留だけ残すと
      // 次のスナップショットまで一覧が古いままになるので、その場で適用する。
      if (!splitRef.current.openTabs.includes(closeTarget.paneId)) {
        heldSnapshot.current = null;
        setClosing(null);
        setState(next);
        return;
      }
      heldSnapshot.current = next;
      beginTabLeave(closeTarget.paneId, closeTarget.next);
      setClosing(null);
      return;
    }
    setState(next);
  };

  // タブのアニメーションと削除のアニメーションがどちらも終わったら、保留した
  // スナップショットを 1 回だけ適用する。待つのは描画だけで、状態の正は BFF のまま。
  useEffect(() => {
    if (leavingTab !== null || removing?.phase === "leave") return;
    const held = heldSnapshot.current;
    if (held === null) return;
    heldSnapshot.current = null;
    // 保留中に別の対象が消えていれば、そのアニメーションへもう一度渡す。
    applyState(held);
  }, [leavingTab, removing?.phase]);

  useEffect(() => {
    const controller = new AbortController();
    fetchState(controller.signal).then(
      (message) => {
        receive(message);
        const decision = gateSnapshot(snapshotWriter.current, "initial-fetch");
        snapshotWriter.current = decision.writer;
        // 取得できた時点で最新の状態はある。最初の SSE スナップショットを再接続扱いにしない。
        live.current = true;
        if (decision.apply) applyState(message.state);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      const message = parseAppState(event.data);
      if (message === null) return;
      receive(message);
      const decision = gateSnapshot(snapshotWriter.current, "stream");
      snapshotWriter.current = decision.writer;
      if (!decision.apply) return;
      if (!live.current) resynced.current = true;
      live.current = true;
      applyState(message.state);
      setConnection(connectionAfter("snapshot"));
    };
    events.addEventListener("unavailable", () => setConnection(connectionAfter("unavailable")));
    // 再接続はブラウザに任せる。ここでは表示だけを切り替える。
    events.onerror = () => {
      live.current = false;
      setConnection(connectionAfter("error"));
    };
    return () => events.close();
  }, []);

  const revision = useRevision();
  const { theme, scheme, changeTheme } = useThemePreference();
  const { prefs: splitPrefs, change: changeSplitPrefs } = useSplitPreference();
  const { side: treeSide, change: changeTreeSide } = useFileTreeSide();
  const {
    size: treeSize,
    width: treeWidth,
    icons: treeIcons,
    changeSize: changeTreeSize,
    changeWidth: changeTreeWidth,
    changeIcons: changeTreeIcons,
  } = useFileTreeDisplay();
  const { interval: liveUpdate, change: changeLiveUpdate } = useLiveUpdate();
  useLiveUpdateTick(liveUpdateMs(liveUpdate));
  // 委譲の検知は「エージェントが付いたペインが前回のスナップショットに無かった」で行う。
  // シェルとして先に現れるペインを取りこぼさないよう、ペインではなくエージェントで覚える。
  const seenAgents = useRef<Set<string> | null>(null);
  // 再接続の最初のスナップショットは差分の基準にしない。切断中の増加を一斉に開かない。
  const resynced = useRef(false);
  const live = useRef(false);
  // hwc から作ったペインは pendingSelect が開く。自動分割と二重に動かさない。
  const selfCreated = useRef(new Set<string>());
  // 分割で入ったセル。次の描画で分割線から広げる。
  const [entering, setEntering] = useState<string | null>(null);

  // 時刻は BFF が持つ。描画のたびに一度だけ Map へ引き直し、表示側の型は変えない。
  const workingSince = toTimes(state?.times.workingSince);
  const finishedAt = toTimes(state?.times.finishedAt);

  useFavicon(state);
  const parentPaneIds = state === null ? NO_PARENT_PANE_IDS : markedParentPaneIds(state);

  // 選んだペインがスナップショットから消えても id は残す。findPane が null を
  // 返すので表示は一覧に戻り、戻ってきたときは同じペインを開ける。タブとスロットは
  // スナップショットに合わせて落とす。
  const rememberedView =
    view ??
    (state === null ? null : (initialView.current ??= defaultView(state, openGroups.current)));
  const exists = (paneId: string) => state !== null && findPane(state, paneId) !== null;
  const split: SplitView =
    state === null || rememberedView === null
      ? (rememberedView?.split ?? EMPTY_SPLIT_VIEW)
      : syncSplitView(rememberedView.split, exists);
  const expanded = rememberedView === null ? NO_GROUPS : rememberedView.expanded;
  expandedRef.current = expanded;
  const selectedPaneId = split.current;
  splitRef.current = split;

  const pane = state ? findPane(state, selectedPaneId) : null;

  // タブ・木・選択は 1 つのキーに保存する。同じ内容を書き直さない。
  const splitKey = `${split.openTabs.join(" ")}\n${split.recent.join(" ")}\n${split.current ?? ""}\n${JSON.stringify(split.layout)}`;
  useEffect(() => {
    if (state === null) return;
    writeSplitView(split);
  }, [splitKey]);

  // ドロップやタブの反映の直前に位置を控え、変わったセルとタブを前の位置から滑らせる。
  const captureFlip = useFlipLayout(splitKey);

  // セルごとに文脈を引く。1 つの context を共有すると、別スペースを並べたときに
  // PR のチップや Git のメニューが別スペースの値になる。
  const context = state ? findPaneContext(state, selectedPaneId) : null;
  // タブバーは表示順。
  const tabRows =
    state === null
      ? []
      : tabPanes(split, wide).flatMap((paneId) => {
          const row = findPaneRow(state, paneId);
          return row === null ? [] : [row];
        });
  const multiSpaceTabs = multiSpace(tabRows.map((row) => row.workspace.id));

  // プレビューは一時タブのまま。対象のペインが開いている間だけ、タブと本文に出せる。
  const {
    preview,
    previewInTab,
    previewing,
    open: openPreview,
    show: showPreview,
    hide: hidePreview,
    close: closePreview,
  } = usePreview({ state, openTabs: split.openTabs });

  // ペインがスナップショットから消えたら、その添付と進行中のアップロードを捨てる。
  // ペインを切り替えただけでは捨てない（戻ってから送れるようにする）。
  useEffect(() => {
    if (state === null) return;
    attachmentStore.prune((paneId) => findPane(state, paneId) !== null);
    // ツリーも同じ。閉じたペインの開閉と取得済みノードを残さない。
    fileTreeStore.prune((paneId) => findPane(state, paneId) !== null);
  }, [state]);
  // 確認の文言は状態を開いた時点で固定しない。ダイアログ中に変わればその値で読む。
  // スナップショットから消えたペインはもう無いので、確認は出さない。
  const closingPane = state === null || closing === null ? null : findPane(state, closing.paneId);
  const closingAvailable =
    state !== null && closing !== null && paneCloseAction(state, closing.paneId) === closing.action;
  const removingWorkspace =
    state === null || removing === null
      ? null
      : (state.workspaces.find((workspace) => workspace.id === removing.workspaceId) ?? null);
  const removingAvailable =
    removingWorkspace?.worktree?.managed === true && removingWorkspace.worktree.isLinkedWorktree;
  const closingSpaceWorkspace =
    state === null || closingSpace === null
      ? null
      : (state.workspaces.find((workspace) => workspace.id === closingSpace.workspaceId) ?? null);
  const closingSpaceAvailable =
    state !== null &&
    closingSpace !== null &&
    closingSpaceWorkspace !== null &&
    canCloseSpace(state, closingSpace.workspaceId);

  // 既読は Herdr の seen を進めて消す。失敗しても通知しない。次にその行を開いて離れたときに
  // もう一度送られるので、ここで知らせても利用者にできることが無い。
  const focusPane = (paneId: string) => {
    focusAgent(paneId).catch(() => {
      // best-effort。選択は既に成立している。
    });
  };

  // 選択の変更は必ずここを通す。既読の保留の判定は scope.ts が持つ。
  // 保留は state にしない（再描画しない）。
  const moveTo = (
    paneId: string | null,
    opened = false,
    explicitExpanded?: ReadonlySet<string>,
  ) => {
    // 帯から移った目印は、次の選択で消す。帯の移動自身は、この後に新しい目印を置く。
    if (explicitExpanded === undefined) setReveal(null);
    const pending = pendingRead.current;
    if (pending !== null) {
      const status = state === null ? null : (findPane(state, pending)?.agentStatus ?? null);
      if (shouldFocusOnLeave(pending, paneId, status)) focusPane(pending);
    }
    pendingRead.current = pendingReadAfter(pending, paneId, opened);
    setPendingSelect(null);
    hidePreview();
    if (paneId === null) {
      setView({ split: clearCurrent(split), expanded: explicitExpanded ?? expanded });
      setSettingsOpen(false);
      return;
    }
    // 明示的な移動。畳んでいた記憶より優先して場所を開き、次に開いたときも開いておく。
    let nextExpanded = explicitExpanded;
    if (nextExpanded === undefined && state !== null) {
      const revealed = revealPane(state, paneId, expanded);
      if (revealed.size !== expanded.size) {
        nextExpanded = revealed;
        rememberOpen(revealPaneGroups(state, paneId), true);
      }
    }
    setView({ split: openPane(split, paneId), expanded: nextExpanded ?? expanded });
    setSettingsOpen(false);
  };

  // 保留を作るのはアクティブ一覧の行だけ。ツリー・詳細のタブバー・復元では作らない。
  const openActivePane = (paneId: string) => {
    if (consumeDraggedClick()) return;
    moveTo(paneId, true);
  };

  const select = (paneId: string) => moveTo(paneId);

  // 一覧のツリーの行。タップは開くだけで、ドラッグの後は開かない。
  const selectFromList = (paneId: string) => {
    if (consumeDraggedClick()) return;
    select(paneId);
  };

  const selectFromTab = (paneId: string) => {
    if (consumeDraggedClick()) return;
    select(paneId);
  };

  const back = () => moveTo(null);

  // 新ペインがスナップショットに現れたら開く。応答の前に SSE が届いていれば、ここで 1 度だけ動く。
  useEffect(() => {
    if (pendingSelect === null || state === null) return;
    if (findPane(state, pendingSelect) === null) return;
    moveTo(pendingSelect);
  }, [state, pendingSelect, expanded]);

  // 作ったペインを一覧で見せる。広い画面は一覧が常に出ているのでそのまま送り、狭い画面は
  // 詳細から戻って一覧が見えたときに送る。作成直後は移動待ちの間だけ一覧が見えるので、
  // その間に送っても詳細を開いた時点で scrollTop が 0 に戻る。移動が済むまで待つ。
  useLayoutEffect(() => {
    if (createdPane === null) return;
    if (state === null || findPane(state, createdPane) === null) return;
    if (!wide && (pane !== null || settingsOpen || pendingSelect !== null)) return;
    setCreatedPane(null);
    setScrollTo({ paneId: createdPane, scope, token: ++scrollToSeq.current });
  }, [createdPane, state, wide, pane, settingsOpen, pendingSelect, scope]);

  // 委譲でエージェントが増えたら、表示中のセルの隣へ差し込む。
  // Herdr に委譲のイベントは無いので、前回のスナップショットとの差分で見る。
  useEffect(() => {
    if (state === null) return;
    const present = allPaneIds(state);
    for (const paneId of selfCreated.current) {
      if (!present.has(paneId)) selfCreated.current.delete(paneId);
    }
    const seen = seenAgents.current;
    const agents = allAgentPaneIds(state);
    if (seen === null || resynced.current) {
      resynced.current = false;
      seenAgents.current = agents;
      return;
    }
    // 見ない間の増加は開かない。設定を切っている間に増えた分も同じ扱いにする。
    if (!wide || !splitPrefs.autoSplit) {
      seenAgents.current = agents;
      return;
    }
    // 作成直後のペインを開く pendingSelect と画面の更新が競合する。この回は見送り、
    // seen を進めずに次のスナップショットで拾い直す。
    if (pendingSelect !== null) return;
    const candidates = newAgentPanes(state, seen).filter((item) => {
      if (!selfCreated.current.has(item.id)) return true;
      // hwc が作ったペインは pendingSelect が開く。委譲として二重に動かさない。
      selfCreated.current.delete(item.id);
      return false;
    });
    seenAgents.current = agents;
    if (candidates.length === 0) return;
    // 木は毎回作り直されるので依存に入れず、イベント時点の最新を ref から読む。
    const result = applyDelegation(state, splitRef.current, candidates);
    if (result === null) return;
    setEntering(result.entering);
    setView({ split: result.split, expanded: expandedRef.current });
  }, [state, wide, splitPrefs.autoSplit, pendingSelect]);

  // 新しいセルは分割線から広げる。最初の描画では幅 0 にしておき、次のフレームで
  // flex-grow を戻すと、既存セルが縮みながら分割線が走る。
  useLayoutEffect(() => {
    if (entering === null) return;
    const cell = document.querySelector<HTMLElement>(`[data-drop-pane="${entering}"]`);
    if (cell === null) {
      setEntering(null);
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        cell.style.flexGrow = "1";
        cell.removeAttribute("data-split-enter");
        setEntering(null);
      });
    });
  }, [entering]);

  const openPaneMenu = (paneId: string, trigger: HTMLElement, fromList = false) => {
    setMenu({ target: { kind: "pane", id: paneId }, trigger, fromList, open: true });
  };

  // スペースの状態表示と見出しの「…」は同じメニューを開く。操作の入口を 1 つに保つ。
  const openWorkspaceMenu = (workspaceId: string, trigger: HTMLElement, fromList = false) => {
    // 前回の失敗を今回の結果として見せない。開き直したときは空の状態から始める。
    setGitAction((current) => (current?.phase === "failed" ? null : current));
    setMenu({ target: { kind: "workspace", id: workspaceId }, trigger, fromList, open: true });
  };

  // 開始時に表示していなくても、応答時点で表示されている詳細には読み直しを伝える。
  // 一覧でクリアを押し、通信待ち中に対象のペインを開く経路があるため。
  const clearOutputForMenu = async (paneId: string): Promise<boolean> => {
    const cleared = await clearPaneOutput(paneId);
    if (cleared) outputHandles.current.get(paneId)?.refreshOutput();
    return cleared;
  };

  const closeMenu = () => {
    // 送信中に別のメニューを開き直しても、古い応答で新しいメニューを閉じない。
    setMenu((current) =>
      current !== null && current === menu ? { ...current, open: false } : current,
    );
  };

  // fetch / pull の実行中は、背景のタップや Esc でメニューを閉じない。閉じても操作は
  // 続くが、結果の表示先が無くなる。明示的な項目（PR リンクなど）はそのまま閉じられる。
  const dismissMenu = () => {
    if (
      gitAction !== null &&
      gitAction.phase === "busy" &&
      menu !== null &&
      menu.target.kind === "workspace" &&
      menu.target.id === gitAction.workspaceId
    ) {
      return;
    }
    closeMenu();
  };

  const runGitSync = async (workspaceId: string, action: "fetch" | "pull") => {
    if (gitActionInFlight.current) return;
    gitActionInFlight.current = true;
    setGitAction({ workspaceId, action, phase: "busy" });
    const outcome = await syncWorkspace(workspaceId, action);
    gitActionInFlight.current = false;
    if (outcome.ok) {
      setGitAction(null);
      closeMenu();
      return;
    }
    setGitAction({ workspaceId, action, phase: "failed", error: outcome.error });
  };

  // 名前とエージェントはダイアログで決める。メニューは入口だけ。
  const openCreateDialog = (paneId: string) => {
    setCreating({ paneId, target: { kind: "split" } });
    closeMenu();
  };

  // シェルペインの入力欄から起動する。ペインは作らないので、名前も追加先も持たない。
  const openStartAgentDialog = (paneId: string) => {
    setCreating({ paneId, target: { kind: "start" } });
  };

  // ツリーで選んだフォルダを作業ディレクトリにしたスペースを作る。モデル一覧は
  // 起点のペインの cwd で読み、起動時の再検証は新しい root pane の cwd で BFF が行う。
  const openCreateSpaceDialog = (paneId: string, path: string) => {
    setCreating({ paneId, target: { kind: "space", path } });
  };

  // ワークツリーはリポジトリ本体のスペースからだけ作る。モデル一覧は起点スペースの先頭ペイン
  // から読み、起動時の再検証は新しい root pane の cwd で BFF が行う。
  const openCreateWorktreeDialog = () => {
    if (menu === null || menu.target.kind !== "workspace" || state === null) return;
    const workspace = state.workspaces.find((item) => item.id === menu.target.id);
    if (workspace === undefined || workspace.worktree === null) return;
    if (workspace.worktree.isLinkedWorktree) return;
    const paneId = workspace.tabs.flatMap((tab) => tab.panes)[0]?.id;
    if (paneId === undefined) return;
    closeMenu();
    setCreating({ paneId, target: { kind: "worktree", workspaceId: workspace.id } });
  };

  // ダイアログが決めた起動の指定を預かる。新しいペインはスナップショットに現れてから、
  // ペインごとに 1 回だけ起動を頼む。起動したかどうかの正はスナップショットに置く。
  const beginLaunch = (paneId: string, intent: LaunchIntent | null) => {
    setLaunches((current) => {
      const next = new Map(current);
      if (intent === null) {
        next.delete(paneId);
      } else {
        next.set(paneId, {
          paneId,
          at: serverClockNow(Date.now(), skew.current),
          agent: intent.agent,
          model: intent.model,
          effort: intent.effort,
          request: "waiting",
          waitForShell: intent.waitForShell,
          error: null,
        });
      }
      return next;
    });
  };

  // 分割の応答より先に Herdr の状態が届かないことがあり、その間は BFF もペインを知らない。
  // スナップショットに現れてから頼む。要求の結果は記録の同一性で照合し、起動したかは
  // スナップショットに決めさせる。
  useEffect(() => {
    if (state === null) return;

    const run = async (launch: PaneLaunch) => {
      const result = await startAgent(launch.paneId, {
        agent: launch.agent,
        model: launch.model,
        effort: launch.effort,
        waitForShell: launch.waitForShell,
      });
      launchRequests.current.delete(launch);
      setLaunches((current) => {
        // 再試行で別の記録に置き換わっていたら、遅れて返った結果で上書きしない。
        if (current.get(launch.paneId) !== launch) return current;
        // 別の経路で起動済みなら待ちを続ける。起動したかはスナップショットが決める。
        if (result.ok || result.error === "pane_not_shell") {
          return new Map(current).set(launch.paneId, {
            ...launch,
            request: "started",
            at: serverClockNow(Date.now(), skew.current),
            error: null,
          });
        }
        return new Map(current).set(launch.paneId, {
          ...launch,
          request: "failed",
          at: serverClockNow(Date.now(), skew.current),
          error: result.error,
        });
      });
    };

    for (const launch of launches.values()) {
      if (launch.request !== "waiting") continue;
      if (launchRequests.current.has(launch)) continue;
      if (findPane(state, launch.paneId) === null) continue;
      launchRequests.current.add(launch);
      void run(launch);
    }
  }, [state, launches]);

  // 起動が終わった記録は、スナップショットが起動完了を示した時点で捨てる。記録は起動中だけの
  // 一時的なもので、残すと後で /exit してシェルに戻ったときに「起動を確認できませんでした」が
  // 蘇る。now は settle と上限の経過を見るために必要。
  useEffect(() => {
    if (launches.size === 0 || state === null) return;
    setLaunches((current) => {
      let next: Map<string, PaneLaunch> | null = null;
      for (const [paneId, launch] of current) {
        const pane = findPane(state, paneId);
        if (pane === null) {
          // 新しいペインは、応答より先に記録だけができていることがある。届くまで残す。
          if (launch.request === "waiting") continue;
          next ??= new Map(current);
          next.delete(paneId);
          continue;
        }
        if (launchPhase(launch, pane, now) !== "ready") continue;
        next ??= new Map(current);
        next.delete(paneId);
      }
      return next ?? current;
    });
  }, [state, launches, now]);

  // 起動に失敗したペインから、同じ指定でもう一度頼む。
  const retryLaunch = (paneId: string) => {
    const launch = launches.get(paneId);
    if (launch === undefined) return;
    beginLaunch(paneId, {
      agent: launch.agent,
      model: launch.model,
      effort: launch.effort,
      waitForShell: launch.waitForShell,
    });
  };

  // 起動を諦め、残ったシェルとして使う。入力欄もシェルの形に戻る。
  const useShell = (paneId: string) => {
    setLaunches((current) => {
      if (!current.has(paneId)) return current;
      const next = new Map(current);
      next.delete(paneId);
      return next;
    });
  };

  // タブから外す操作は、対象のタブが縮むアニメーションを見せてから履歴に反映する。
  // 先に別のタブを外したときは、前の対象をすぐ反映して 1 つだけ動かす。
  const finishTabLeave = (paneId: string) => {
    const target = leavingTabRef.current;
    if (target === null || target.paneId !== paneId) return;
    if (leaveTabTimer.current !== null) {
      window.clearTimeout(leaveTabTimer.current);
      leaveTabTimer.current = null;
    }
    leavingTabRef.current = null;
    setLeavingTab(null);
    // 縮み終わってからタブ順が変わる。残ったタブをその位置から滑らせる。
    captureFlip();
    setView({
      split: removeTab(splitRef.current, target.paneId, target.successor, wide),
      expanded: expandedRef.current,
    });
  };

  const beginTabLeave = (paneId: string, successor?: string | null) => {
    const pending = leavingTabRef.current;
    if (pending !== null) {
      if (pending.paneId === paneId) return;
      finishTabLeave(pending.paneId);
    }
    if (!splitRef.current.openTabs.includes(paneId)) return;
    const target = { paneId, successor };
    leavingTabRef.current = target;
    setLeavingTab(target);
    leaveTabTimer.current = window.setTimeout(() => finishTabLeave(paneId), TAB_LEAVE_FALLBACK_MS);
  };

  // タブの × はタブから外すだけ。ペインは閉じず、Herdr 側で動き続ける。
  const removeFromTabs = (paneId: string) => beginTabLeave(paneId);

  // 確認を開く時点のスナップショットで、閉じたあとに選ぶペインを決めておく。SSE が
  // 閉じたペインを落とした後では、後継を引けない。
  const requestClose = (paneId: string) => {
    if (state === null) return;
    const action = paneCloseAction(state, paneId);
    if (action === null || action === "keep") return;
    setClosing({
      paneId,
      action,
      next: nextTabPane(split, paneId, wide),
      phase: "confirm",
    });
  };

  const openCloseConfirm = () => {
    if (menu === null || menu.target.kind !== "pane") return;
    const paneId = menu.target.id;
    closeMenu();
    requestClose(paneId);
  };

  // 送信中は閉じる手段を受け付けない。結果の反映を 1 回に保つ。
  const cancelClose = () => {
    if (closing?.phase === "busy") return;
    setClosing(null);
  };

  // 閉じたペインはローカルで消さない。表示は SSE のスナップショットで置き換える。
  const confirmClose = () => {
    if (closing === null || closing.phase === "busy" || !closingAvailable) return;
    if (closeInFlight.current) return;
    closeInFlight.current = true;
    const target = closing;
    setClosing({ ...target, phase: "busy" });
    void closePane(target.paneId, target.action).then((outcome) => {
      closeInFlight.current = false;
      // スナップショットが先にペインを落とした場合は、既にタブを外すアニメーションへ
      // 渡している。遅れて届いた応答で確認や表示を戻さない。
      if (leavingTabRef.current?.paneId === target.paneId) return;
      if (outcome !== "done") {
        setClosing((current) => (current === null ? null : { ...current, phase: "failed" }));
        return;
      }
      // 選んでいないペインを閉じても、読んでいるペインを動かさない。exit は終了要求で
      // ペインが残るので、履歴は動かさない（消えたらスナップショットで落とす）。
      if (target.action === "close") {
        beginTabLeave(target.paneId, target.next);
      }
      setClosing(null);
    });
  };

  // チェックアウトの削除は取り消せない。Herdr の TUI と同じく、確認は 1 回だけにする。
  const openRemoveWorktreeConfirm = () => {
    if (menu === null || menu.target.kind !== "workspace" || state === null) return;
    const workspace = state.workspaces.find((item) => item.id === menu.target.id);
    if (
      workspace === undefined ||
      workspace.worktree?.managed !== true ||
      !workspace.worktree.isLinkedWorktree
    ) {
      return;
    }
    closeMenu();
    setRemoving({
      workspaceId: workspace.id,
      label: workspace.label,
      checkoutPath: workspace.worktree.checkoutPath,
      phase: "confirm",
    });
  };

  const cancelRemoveWorktree = () => {
    if (removing?.phase === "busy") return;
    setRemoving(null);
  };

  // 消えたスペースはローカルで消さない。一覧の置き換えは SSE のスナップショットに任せる。
  // 成功時は確認を閉じ、一覧の対象が消えるアニメーションを先に見せる。
  const confirmRemoveWorktree = () => {
    if (
      removing === null ||
      removing.phase === "busy" ||
      removing.phase === "leave" ||
      !removingAvailable
    ) {
      return;
    }
    if (removeInFlight.current) return;
    removeInFlight.current = true;
    const target = removing;
    setRemoving({ ...target, phase: "busy" });
    void removeWorktree(target.workspaceId).then((outcome) => {
      removeInFlight.current = false;
      if (outcome === "done") {
        beginRemovalLeave();
        return;
      }
      // 応答より先に対象が消えていた場合は、削除済みとして扱う。
      if (removingRef.current?.phase === "leave") {
        finishRemoval();
        return;
      }
      setRemoving((current) => (current === null ? null : { ...current, phase: "failed" }));
    });
  };

  // 最後の 1 つは残す。それ以外は、重複していなくても閉じられる。
  const openCloseSpaceConfirm = () => {
    if (menu === null || menu.target.kind !== "workspace" || state === null) return;
    const workspace = state.workspaces.find((item) => item.id === menu.target.id);
    if (workspace === undefined || !canCloseSpace(state, workspace.id)) return;
    closeMenu();
    setClosingSpace({
      workspaceId: workspace.id,
      label: workspace.label,
      path: workspace.path ?? null,
      phase: "confirm",
    });
  };

  const cancelCloseSpace = () => {
    if (closingSpace?.phase === "busy") return;
    setClosingSpace(null);
  };

  const confirmCloseSpace = () => {
    if (closingSpace === null || closingSpace.phase === "busy" || !closingSpaceAvailable) return;
    if (closeSpaceInFlight.current) return;
    closeSpaceInFlight.current = true;
    const target = closingSpace;
    setClosingSpace({ ...target, phase: "busy" });
    void closeWorkspace(target.workspaceId).then((outcome) => {
      closeSpaceInFlight.current = false;
      setClosingSpace((current) => {
        if (current === null) return null;
        return outcome === "done" ? null : { ...current, phase: "failed" };
      });
    });
  };

  const toggle = (groupId: string) => {
    setReveal(null);
    const next = new Set(expanded);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setView({ split, expanded: next });
    rememberOpen([groupId], next.has(groupId));
  };

  // 送れたかどうかを返す。失敗したら入力欄が下書きを残せるようにする。
  // 失敗は送信した入口で伝える。本文は消さず、再試行できるようにする。
  const sendToPane = async (
    paneId: string,
    text: string,
    attachments: string[],
  ): Promise<boolean> => {
    if (inputsInFlight.current.has(paneId)) return false;
    inputsInFlight.current.add(paneId);
    inputChanged(undefined);
    try {
      await sendInput(paneId, text, attachments);
    } catch {
      return false;
    } finally {
      inputsInFlight.current.delete(paneId);
      inputChanged(undefined);
    }
    return true;
  };

  // 停止も送信と同じく、結果を画面に反映するのは PaneDetail に任せる。
  const stopPane = async (paneId: string): Promise<boolean> => {
    try {
      await stopAgent(paneId);
    } catch {
      return false;
    }
    return true;
  };

  const confirmPaneFolderTrust = async (paneId: string, id: string) => {
    if (confirmationAttempts.current.has(id)) return;
    const update = (attempt: ConfirmationAttempt) => {
      confirmationAttempts.current.set(id, attempt);
      confirmationChanged(undefined);
    };
    update("sending");
    try {
      await confirmFolderTrust(paneId, id);
      update("waiting");
    } catch {
      update("failed");
    }
  };

  // シェルの前景プロセスは Herdr のイベントに載らない。グリッドに入っているペインと
  // current のシェルだけを読む。開いた履歴の全部を読むと、3 秒ごとの要求が増える。
  const polledIds =
    state === null
      ? []
      : [
          ...new Set([
            ...leafPanes(split.layout),
            ...(selectedPaneId === null ? [] : [selectedPaneId]),
          ]),
        ].filter((id) => findPane(state, id)?.agent === null);
  const processes = usePaneProcesses(polledIds);

  const { sidebarWidth, setSidebarWidth, saveSidebarWidth, drag } = useSidebarWidth();
  const { sidebarCollapsed, toggleSidebar } = useSidebarCollapsed();

  // アクティブの帯から「すべて」のその場所へ移る。スコープと一覧のスクロールは PaneList が
  // 持ち、ここでは代表ペインと開閉だけを決める。狭い画面は一覧と詳細を同時に出せず、
  // 目的はワークツリーメニューなので、代表ペインは選ばず一覧のまま移る。
  const revealWorkspace = (workspaceId: string) => {
    if (state === null) return;
    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (workspace === undefined) return;
    const nextExpanded = expandForWorkspace(state, workspaceId, expanded);
    if (nextExpanded === null) return;
    const target = defaultPaneOf(workspace);
    moveTo(wide && target !== null ? target.pane.id : null, false, nextExpanded);
    rememberOpen(workspaceGroupIds(state, workspace), true);
    setReveal({ workspaceId, token: ++revealSeq.current });
  };

  const connChip = <ConnectionChip status={connection} />;

  const actions = (
    <>
      {connChip}
      {/* 足元は入口だけ。出口は設定の左上にあり、開いている間はその面の色で示す。 */}
      <button
        type="button"
        class="hwc-icon-button hwc-foot-button"
        aria-label="設定"
        aria-pressed={settingsOpen}
        data-current={settingsOpen ? "true" : undefined}
        onClick={() => setSettingsOpen((open) => !open)}
      >
        <SettingsIcon />
      </button>
    </>
  );

  // 接続は一覧の足元に出す。チャットは狭い画面で足元が隠れるので、タブバーの右端に
  // 異常のときだけ出す。正常な間は何も出さず、タブの幅を空けておく。
  const detailStatus = wide || connection === "live" ? null : connChip;

  // ドラッグの適用先。タブとセルの両方から掴むので、最新の状態を持つ関数を hook に渡す。
  // 落としたときの選択はレイアウト操作。一覧の行を開いたわけではないので、既読の
  // 保留は作らない（タブからのドラッグと同じ）。
  const applyDrop = (paneId: string, target: DropTarget) => {
    // ドラッグは広い画面だけで始まる。途中で幅が変わっても開始時の分割として扱う。
    const mode = target.kind === "tab" ? tabDropMode(split, paneId, target.pane, true) : null;
    if (target.kind === "tab" && mode === null) return;
    const next =
      target.kind === "tab" && mode === "insert"
        ? moveTab(split, paneId, target.pane, target.side)
        : dropOnPane(
            split,
            paneId,
            target.pane,
            target.kind === "tab" ? "center" : target.zone,
            true,
          );
    if (next === split) return;
    captureFlip();
    setView({ split: next, expanded });
  };
  const { dragging, startPaneDrag, startListPaneDrag, consumeDraggedClick } = usePaneDrag({
    wide,
    split: splitRef,
    onDrop: applyDrop,
  });

  // 掴んでいるタブの見出し。タブバーと同じ名前を使い、掴んだものがそのまま付いてくるようにする。
  const draggedRow =
    state === null || dragging === null ? null : findPaneRow(state, dragging.paneId);
  const draggingLabel =
    draggedRow === null
      ? ""
      : tabLabelText(
          tabLabel(
            shortenSpaceName(draggedRow.workspace),
            tabDisplayName(
              activeRowName(
                draggedRow.workspace.label,
                paneTabName(draggedRow.pane, processes.get(draggedRow.pane.id) ?? null),
              ),
              draggedRow.workspace,
            ),
            multiSpaceTabs,
          ),
        );
  // タブの落とし先。分割では枠、1 枚表示では差し込みの線で示す。
  const tabDrop =
    dragging?.target?.kind === "tab"
      ? {
          pane: dragging.target.pane,
          side:
            tabDropMode(split, dragging.paneId, dragging.target.pane, wide) === "insert"
              ? dragging.target.side
              : null,
        }
      : null;

  // 空きの葉は持たない。
  const layoutPanes = readingOrder(split.layout);
  const splitCells = wide && layoutPanes.length > 1;
  const gridOn = wide && pane !== null && split.layout !== null;
  const compact = splitCells;
  // 消えるペインが画面に出ているとき、本文側でも同じ時間だけ淡く消す。セルが並ぶ
  // ときはそのセルだけを対象にし、1 枚表示のときは本文全体を対象にする。
  const leavingPaneId = leavingTab?.paneId ?? null;
  const leavingInCell =
    leavingPaneId !== null && !previewing && gridOn && layoutPanes.includes(leavingPaneId);
  const detailLeaving =
    leavingPaneId !== null && leavingPaneId === selectedPaneId && !leavingInCell;

  // 4 枚の判定は BFF と同じタブの枚数で行う。
  const menuPaneId = menu?.target.kind === "pane" ? menu.target.id : null;
  const menuRow = state === null ? null : findPaneRow(state, menuPaneId);
  const menuTab = menuRow?.tab ?? null;
  const menuFull = menuTab !== null && menuTab.panes.length >= MAX_PANES_PER_TAB;
  const menuPane = menuRow?.pane ?? null;
  const menuCloseAction =
    state === null || menuPaneId === null ? null : paneCloseAction(state, menuPaneId);
  const menuWorkspace =
    menu?.target.kind === "workspace"
      ? (state?.workspaces.find((workspace) => workspace.id === menu.target.id) ?? null)
      : null;
  const menuPullRequest =
    menuWorkspace === null ? null : (pullRequests.get(menuWorkspace.id) ?? null);
  const menuRepoUrl = menuWorkspace?.sync?.repoUrl ?? null;
  const menuGitBusy =
    menuWorkspace !== null &&
    gitAction !== null &&
    gitAction.workspaceId === menuWorkspace.id &&
    gitAction.phase === "busy"
      ? gitAction.action
      : null;
  const menuGitFailed =
    menuWorkspace !== null &&
    gitAction !== null &&
    gitAction.workspaceId === menuWorkspace.id &&
    gitAction.phase === "failed"
      ? { action: gitAction.action, error: gitAction.error }
      : null;
  // 一般のスペース作成は持たない。worktree.create で開くスペースだけを例外にする。
  const menuWorktree = menuWorkspace?.worktree ?? null;
  const canCreateWorktree = menuWorktree !== null && !menuWorktree.isLinkedWorktree;
  const menuCanCloseSpace =
    state !== null && menuWorkspace !== null && canCloseSpace(state, menuWorkspace.id);
  // 並びの正は Herdr。メニューはその移動を 1 タップで呼ぶだけで、hwc 側に順序は持たない。
  // 既に先頭の束には項目を出さない。
  const menuCanMoveToTop =
    state !== null &&
    menuWorkspace !== null &&
    moveToTopPlan(
      orderUnits(groupWorkspaces(state.workspaces), state.workspaces),
      menuWorkspace.id,
    ) !== null;
  const moveWorkspaceToTop = () => {
    if (menuWorkspace === null) return;
    moveToTopSeq.current += 1;
    setMoveToTop({ workspaceId: menuWorkspace.id, token: moveToTopSeq.current });
    closeMenu();
  };

  const renderPane = (
    item: PaneState,
    where: PaneContext,
    compact: boolean,
    isCurrent: boolean,
  ) => {
    const launch = launches.get(item.id) ?? null;
    const phase = launchPhase(launch, item, now);
    const launchView: PaneLaunchView | null =
      launch === null || phase === null
        ? null
        : {
            phase,
            agent: launch.agent,
            model: launch.model,
            effort: launch.effort,
            error: launch.request === "failed" ? launch.error : null,
          };
    return (
      <PaneDetail
        key={item.id}
        pane={item}
        context={where}
        compact={compact}
        scheme={scheme}
        treeSide={treeSide}
        treeWidth={fileTreeWidthPx(treeWidth)}
        treeIcons={treeIcons}
        current={isCurrent}
        // 名前はタブのチップと重なる。セルが並ぶときだけ、どのセルかを示すために出す。
        labeled={splitCells}
        // 親ペインの印はタブの幅を食うので、セル見出しに出す。
        parentPaneIds={parentPaneIds}
        // 複数スペースのペインが並ぶときだけ、見出しに場所を添える。
        showSpace={splitCells && multiSpaceTabs}
        // ブランチの文字は一覧が隠れる狭い画面でだけ出す。分割セルでも PR のチップを引くため、
        // 値そのものは常に渡す。
        branch={where.branch}
        // 上流との差はワークスペースの属性。セルが並ぶときは同じ値が並ぶので出さない。
        sync={splitCells ? null : where.sync}
        // 上流との差はセルでは出さないが、PR を引く鍵はセルでも要る。表示用の sync とは
        // 別に渡し、分割表示のまま push してもチップが引き直せるようにする。
        upstreamBranch={where.sync?.upstreamBranch ?? null}
        workspaceMenuOpen={
          menu?.open === true &&
          menu.target.kind === "workspace" &&
          menu.target.id === where.workspaceId
        }
        // 広い画面でも PR のチップは見出しに出す。ブランチだけを隠す。
        showBranch={!wide}
        waitingMs={item.agentStatus === "working" ? workingMs(workingSince, item.id, now) : null}
        now={now}
        running={processes.get(item.id)?.running === true}
        sending={inputsInFlight.current.has(item.id)}
        launch={launchView}
        dismissedConfirmation={dismissedConfirmations[item.id] ?? null}
        confirmationAttempts={confirmationAttempts.current}
        onConfirmFolderTrust={(id) => void confirmPaneFolderTrust(item.id, id)}
        onDismissConfirmation={(id) =>
          setDismissedConfirmations((current) => ({ ...current, [item.id]: id }))
        }
        menuOpen={menu?.open === true && !menu.fromList && menuPaneId === item.id}
        outputRef={(handle) => {
          if (handle === null) outputHandles.current.delete(item.id);
          else outputHandles.current.set(item.id, handle);
        }}
        onOpenMenu={openPaneMenu}
        onOpenWorkspaceMenu={openWorkspaceMenu}
        onSubmit={(text, attachments) => sendToPane(item.id, text, attachments)}
        onStop={() => stopPane(item.id)}
        onStartAgent={() => openStartAgentDialog(item.id)}
        onCreateSpace={(path) => openCreateSpaceDialog(item.id, path)}
        onRetryLaunch={() => retryLaunch(item.id)}
        onUseShell={() => useShell(item.id)}
        onOpenImage={(url, name) => setViewer({ url, name })}
        onOpenPreview={(file) => openPreview(item.id, file)}
      />
    );
  };

  // ドラッグ中のプレビューの文言。中央は木の中なら入れ替え、外のタブなら置換。
  const dropLabel = (zone: DropZone, moving: string | null): string => {
    if (zone !== "center") {
      return { top: "上に追加", bottom: "下に追加", left: "左に追加", right: "右に追加" }[zone];
    }
    return moving !== null && layoutPanes.includes(moving) ? "ここで入れ替え" : "この位置に表示";
  };

  // セルは木の葉。親の分割軸を data 属性に置き、ドラッグ中の向き判定に使う。
  const renderCell = (paneId: string, parentDir: "row" | "col" | null) => {
    if (state === null) return null;
    const item = findPane(state, paneId);
    if (item === null) return null;
    const where = findPaneContext(state, paneId);
    const isCurrent = item.id === pane?.id;
    // クリックしたセルを current にする。Herdr のフォーカスに追従させると、
    // HWC から動かせないセルが current のままになる。
    const activate = () => {
      if (!isCurrent) select(item.id);
    };
    // 見出しの focus() などプログラム的なフォーカスで current を動かさない。
    // 操作できる要素へフォーカスが入ったときだけ、そのセルを選ぶ。
    const activateFromFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          "button, input, textarea, select, a[href], [contenteditable]:not([contenteditable='false'])",
        ) === null
      ) {
        return;
      }
      activate();
    };
    // ドラッグはセルの見出しからだけ始める。出力と入力の選択・操作を奪わない。
    const dragFromHead = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".hwc-pane-head") === null) return;
      if (
        target.closest(
          "button, input, textarea, select, a[href], [contenteditable]:not([contenteditable='false'])",
        ) !== null
      ) {
        return;
      }
      startPaneDrag(event, item.id);
    };
    // 落とし先が固定タブのときは、セル側に枠を出さない。
    const target =
      dragging?.target?.kind === "cell" && dragging.target.pane === item.id
        ? dragging.target
        : null;
    return (
      <section
        class="hwc-split-cell"
        data-slot={layoutPanes.indexOf(item.id) + 1}
        data-compact={compact}
        data-current={isCurrent}
        data-drop-pane={item.id}
        data-drop-parent={parentDir ?? undefined}
        data-split-enter={item.id === entering ? "true" : undefined}
        data-leaving={leavingTab?.paneId === item.id ? "true" : undefined}
        key={item.id}
        onPointerDown={(event) => {
          activate();
          dragFromHead(event);
        }}
        onFocusIn={activateFromFocus}
      >
        {where === null ? null : renderPane(item, where, compact, isCurrent)}
        {target === null ? null : (
          <div class="hwc-drop" data-zone={target.zone} aria-hidden="true">
            <span>{dropLabel(target.zone, dragging?.paneId ?? null)}</span>
          </div>
        )}
      </section>
    );
  };

  // 分割は再帰。子の親方向をそのまま渡し、端の向きを決める。
  const renderSplit = (node: SplitNode, parentDir: "row" | "col" | null) =>
    node.kind === "leaf" ? (
      renderCell(node.pane, parentDir)
    ) : (
      <div class="hwc-split" data-dir={node.dir}>
        {node.children.map((child) => renderSplit(child, node.dir))}
      </div>
    );

  const overlays: AppOverlaysProps = {
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
    closingAvailable,
    confirmClose,
    cancelClose,
    removing,
    removingWorkspace,
    removingAvailable,
    confirmRemoveWorktree,
    cancelRemoveWorktree,
    closingSpace,
    closingSpaceAvailable,
    confirmCloseSpace,
    cancelCloseSpace,
    creating,
    setCreating,
    // hwc から作ったペインは、自動分割の対象にしない。
    setPendingSelect: (paneId) => {
      if (paneId !== null) {
        selfCreated.current.add(paneId);
        setCreatedPane(paneId);
      }
      setPendingSelect(paneId);
    },
    beginLaunch,
    viewer,
    setViewer,
  };

  return (
    <div
      class="hwc-app"
      data-view={settingsOpen ? "settings" : pane ? "detail" : "list"}
      data-sidebar={sidebarCollapsed ? "collapsed" : "open"}
      style={{
        "--hwc-sidebar-width": `${sidebarWidth}px`,
        "--hwc-split-duration": `${splitMotionDuration(splitPrefs.motion)}ms`,
        "--hwc-tree-width": `${fileTreeWidthPx(treeWidth)}px`,
        "--hwc-tree-font-size": fileTreeFontSize(treeSize),
      }}
    >
      <div class="hwc-body">
        <aside
          class="hwc-list"
          id="hwc-sidebar"
          aria-label="ペイン一覧"
          inert={wide && sidebarCollapsed}
        >
          {state === null ? (
            <ListPlaceholder connection={connection} />
          ) : (
            <PaneList
              state={state}
              selectedPaneId={selectedPaneId}
              // スロット色は PC だけ。狭い画面ではタブ履歴と 2 段目だけを出す。
              slots={wide ? layoutPanes : NO_SLOTS}
              parentPaneIds={parentPaneIds}
              scope={scope}
              onScope={changeScope}
              expanded={expanded}
              onSelect={selectFromList}
              onOpen={openActivePane}
              onDragStart={startListPaneDrag}
              onRevealWorkspace={revealWorkspace}
              reveal={reveal}
              scrollTo={scrollTo}
              onToggle={toggle}
              openPaneMenuId={menu?.open === true && menu.fromList ? menuPaneId : null}
              openWorkspaceMenuId={menu?.open === true ? (menuWorkspace?.id ?? null) : null}
              onPaneMenu={(paneId, trigger) => openPaneMenu(paneId, trigger, true)}
              onWorkspaceMenu={(workspaceId, trigger) =>
                openWorkspaceMenu(workspaceId, trigger, true)
              }
              moveToTop={moveToTop}
              onMoveToTopHandled={() => setMoveToTop(null)}
              onMoveWorkspaces={(workspaceIds, beforeWorkspaceId) =>
                moveWorkspaceBlock(workspaceIds, beforeWorkspaceId)
              }
              removal={
                removing === null
                  ? null
                  : { workspaceId: removing.workspaceId, phase: removing.phase }
              }
              onRemovalFinished={finishRemoval}
              workingSince={workingSince}
              finishedAt={finishedAt}
              pullRequests={pullRequests}
              now={now}
            />
          )}
          <div class="hwc-sidebar-foot">
            <span class="hwc-foot-brand">
              <FooterBrand />
              {revision === null ? null : <span class="hwc-foot-rev">{revision}</span>}
            </span>
            <span class="hwc-foot-actions">{actions}</span>
          </div>
        </aside>

        <div
          class="hwc-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="一覧の幅"
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { startX: event.clientX, startWidth: sidebarWidth };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setSidebarWidth(
              clampSidebarWidth(
                drag.current.startWidth + event.clientX - drag.current.startX,
                window.innerWidth,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (!drag.current) return;
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            saveSidebarWidth(sidebarWidth);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            saveSidebarWidth(
              sidebarWidth + (event.key === "ArrowLeft" ? -SIDEBAR_STEP : SIDEBAR_STEP),
            );
          }}
        />

        {/* タブバーの左端には置かない。設定・空状態・読み込み中はタブバーが無く、畳んだまま開けなくなる。 */}
        <div class="hwc-sidebar-edge">
          <button
            type="button"
            class="hwc-sidebar-toggle"
            aria-label={sidebarCollapsed ? "一覧を開く" : "一覧を閉じる"}
            aria-controls="hwc-sidebar"
            aria-expanded={!sidebarCollapsed}
            onClick={toggleSidebar}
          >
            <ChevronLeftIcon size={14} />
          </button>
        </div>

        <main class="hwc-detail">
          {settingsOpen ? (
            <Settings
              key="settings"
              theme={theme}
              onThemeChange={changeTheme}
              splitPrefs={splitPrefs}
              onSplitPrefsChange={changeSplitPrefs}
              liveUpdate={liveUpdate}
              onLiveUpdateChange={changeLiveUpdate}
              treeSide={treeSide}
              onTreeSideChange={changeTreeSide}
              treeSize={treeSize}
              onTreeSizeChange={changeTreeSize}
              treeWidth={treeWidth}
              onTreeWidthChange={changeTreeWidth}
              treeIcons={treeIcons}
              onTreeIconsChange={changeTreeIcons}
              revision={revision}
              connection={connection}
              wide={wide}
              onClose={() => setSettingsOpen(false)}
            />
          ) : state === null ? (
            <Placeholder connection={connection} />
          ) : (wide && tabRows.length > 0) || pane !== null ? (
            <div class="hwc-detail-inner">
              <TabBar
                tabs={tabRows}
                slots={wide ? layoutPanes : NO_SLOTS}
                currentPaneId={selectedPaneId}
                multiSpace={multiSpaceTabs}
                parentPaneIds={parentPaneIds}
                processes={processes}
                preview={
                  preview !== null && previewInTab
                    ? {
                        name: messageFileLabel(preview.file.name),
                        selected: preview.shown,
                      }
                    : null
                }
                status={detailStatus}
                leavingPaneId={leavingPaneId}
                onSelectPane={selectFromTab}
                onRemoveTab={removeFromTabs}
                onLeaveFinished={finishTabLeave}
                onSelectPreview={showPreview}
                onClosePreview={closePreview}
                onBack={back}
                onDragStart={startPaneDrag}
                canReorder={wide && layoutPanes.length <= 1}
                tabDrop={tabDrop}
              />
              <div class="hwc-detail-body" data-leaving={detailLeaving ? "true" : undefined}>
                {previewing && preview !== null ? (
                  <Preview
                    key={`${preview.paneId}:${preview.file.name}@${preview.file.version}`}
                    paneId={preview.paneId}
                    file={preview.file}
                    onClose={closePreview}
                  />
                ) : pane === null || context === null ? (
                  <div class="hwc-empty hwc-empty--detail">
                    <div class="hwc-empty-mark hwc-empty-mark--app">
                      <HwcMark size={40} />
                    </div>
                    <h2 class="hwc-empty-title">ペインを選んでください</h2>
                    <p class="hwc-empty-text">
                      タブか一覧からペインを選ぶと、出力と入力欄が出ます。
                    </p>
                  </div>
                ) : gridOn && split.layout !== null ? (
                  <div class="hwc-detail-grid" data-single={layoutPanes.length === 1}>
                    {renderSplit(split.layout, null)}
                  </div>
                ) : (
                  renderPane(pane, context, false, true)
                )}
              </div>
            </div>
          ) : (
            <div class="hwc-empty hwc-empty--detail">
              <div class="hwc-empty-mark hwc-empty-mark--app">
                <HwcMark size={40} />
              </div>
              <h2 class="hwc-empty-title">ペインを選んでください</h2>
              <p class="hwc-empty-text">一覧からペインを選ぶと、出力と入力欄が出ます。</p>
            </div>
          )}
        </main>
      </div>

      <AppOverlays {...overlays} />
    </div>
  );
}
