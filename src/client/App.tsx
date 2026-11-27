import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import type { AppState } from "../server/herdr/state";
import { attachmentStore } from "./attachment-store";
import { codeFontSize } from "./code-font-size";
import { fileTreeFontSize, fileTreeWidthPx } from "./file-tree-display";
import { fileTreeStore } from "./file-tree-store";
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
import { CellTree, PreviewCell, type CellActions, type CellContext } from "./app/cells";
import { menuView } from "./app/menu";
import { tabRows } from "./app/tab-rows";
import { useConfirmFlow } from "./app/hooks/use-confirm-flow";
import { useFavicon } from "./app/hooks/use-favicon";
import { useCodeFontSize } from "./app/hooks/use-code-font-size";
import { useFileTreeDisplay } from "./app/hooks/use-file-tree-display";
import { useFileTreeSide } from "./app/hooks/use-file-tree-side";
import { useLaunches } from "./app/hooks/use-launches";
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
  closeWorkspace,
  moveWorkspaceBlock,
  parseAppState,
  removeWorktree,
  syncWorkspace,
} from "./requests/workspaces";
import {
  focusAgent,
  clearPaneOutput,
  closePane,
  confirmFolderTrust,
  sendInput,
  stopAgent,
} from "./requests/panes";
import { INITIAL_CONNECTION, connectionAfter, type ConnectionStatus } from "./connection";
import { liveUpdateMs } from "./live-update";
import { allAgentPaneIds, allPaneIds, applyDelegation, newAgentPanes } from "./delegation";
import { splitMotionDuration } from "./split-prefs";
import { ConnectionChip } from "./ConnectionChip";
import { ChevronRightIcon, HwcMark, SettingsIcon } from "./icons";
import { paneTabName, usePaneProcesses } from "./process";
import { useWorkspacePullRequests } from "./pull-request";
import type { PaneOutputHandle } from "./commands";
import type { ConfirmationAttempt } from "./confirmation";
import { paneCloseAction } from "../shared/pane-close";
import {
  canCloseSpace,
  findPane,
  findPaneRow,
  markedParentPaneIds,
  shortenPaneName,
  shortenSpaceName,
  tabLabel,
  tabLabelText,
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
  activePanes,
  clearCurrent,
  dropOnPane,
  layoutKey,
  leafOfPane,
  moveTab,
  openPane,
  openTabs,
  readingOrder,
  removeTab,
  successorTab,
  syncSplitView,
  type SplitView,
} from "./split-view";
import { pendingReadAfter, shouldFocusOnLeave, type ListScope } from "./scope";
import { decideSnapshotApply } from "./snapshot-apply";
import { gateSnapshot, type SnapshotOrigin } from "./snapshot";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_STEP,
  WIDE_LAYOUT_QUERY,
  clampSidebarWidth,
} from "./layout";

const NO_GROUPS: ReadonlySet<string> = new Set();

const NO_PARENT_PANE_IDS: ReadonlySet<string> = new Set();

// 一覧の行が消えるアニメーション（PaneList）の完了が届かない場合の保険。
// 待っている間も他の表示は止まるので、アニメーションより少し長い程度に留める。
const REMOVAL_LEAVE_FALLBACK_MS = 800;

// タブのアニメーションの完了が届かない場合の保険。SSE の適用もこの間だけ遅らせる。
const TAB_LEAVE_FALLBACK_MS = 400;

// タブを外した直後の、ブラウザによる自動フォーカス移動を無視する時間。消える
// アニメーション（180ms）とその直後の focusin を覆い、利用者が 350ms 後に
// フォーカスしたら通る長さにする。
const FOCUS_SUPPRESS_MS = 250;

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
  const [leavingTab, setLeavingTab] = useState<LeavingTab | null>(null);
  const [creating, setCreating] = useState<CreatingPane | null>(null);
  // 拡大中の画像。ダイアログは App 直下。
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);
  // 応答で受け取った新ペインは、スナップショットに現れてから開く。先に選ぶと一覧が一瞬出る。
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  // 既読の保留。アクティブ一覧で開いたペインだけが入り、選択が離れた時点で判定する。
  const pendingRead = useRef<string | null>(null);
  // 外すタブのアニメーション中も、スナップショットの適用を 1 回だけ保留する。
  const leavingTabRef = useRef<LeavingTab | null>(null);
  leavingTabRef.current = leavingTab;
  const leaveTabTimer = useRef<number | null>(null);
  // タブを外した直後、消えたボタンからフォーカスが隣のセルへ移ることがある。
  // その移動で current を変えないよう、短い間だけ focusin を無視する。
  const suppressFocusActivation = useRef(false);
  const suppressFocusTimer = useRef<number | null>(null);
  const clearFocusSuppression = () => {
    suppressFocusActivation.current = false;
    if (suppressFocusTimer.current !== null) {
      window.clearTimeout(suppressFocusTimer.current);
      suppressFocusTimer.current = null;
    }
  };
  // 利用者が自分で pointerdown / keydown したら、そのフォーカス移動は通す。
  // × を押した同じ pointerdown は beginTabLeave より前なので、ここでは解除されない。
  useEffect(() => {
    const release = () => clearFocusSuppression();
    window.addEventListener("pointerdown", release, true);
    window.addEventListener("keydown", release, true);
    return () => {
      window.removeEventListener("pointerdown", release, true);
      window.removeEventListener("keydown", release, true);
      clearFocusSuppression();
    };
  }, []);
  const heldSnapshot = useRef<AppState | null>(null);
  const heldSnapshotTimer = useRef<number | null>(null);

  // 確認の操作は 3 つとも同じ形。対象は開いた時点のスナップショットから写し、
  // 違いは対象の条件・実行する要求・応答後の後始末だけに残す。
  const closing = useConfirmFlow<Closing>({
    present: (target) => state !== null && paneCloseAction(state, target.paneId) === target.action,
    request: (target) => closePane(target.paneId, target.action),
    settled: (current, outcome) => {
      // 閉じたペインはローカルで消さない。一覧とタブは SSE のスナップショットで置き換える。
      if (outcome !== "done") return "failed";
      // 選んでいないペインを閉じても、読んでいるペインを動かさない。exit は終了要求で
      // ペインが残るので、履歴は動かさない（消えたらスナップショットで落とす）。
      if (current.target.action === "close") {
        beginTabLeave(current.target.paneId, current.target.next);
      }
      return null;
    },
  });
  const removing = useConfirmFlow<Removing, "leave">({
    // 削除できるのは、Herdr が作った linked worktree だけ。
    present: (target) => {
      const workspace = state?.workspaces.find((item) => item.id === target.workspaceId);
      return workspace?.worktree?.managed === true && workspace.worktree.isLinkedWorktree;
    },
    request: (target) => removeWorktree(target.workspaceId),
    settled: (current, outcome) => {
      // 消えたスペースはローカルで消さない。一覧の置き換えは SSE のスナップショットに任せる。
      if (outcome === "done") {
        // 成功時は確認を閉じ、一覧の対象が消えるアニメーションを先に見せる。
        armRemovalFallback();
        return "leave";
      }
      // 応答より先に対象が消えていた場合は、削除済みとして扱う。
      if (current.phase === "leave") {
        finishRemoval();
        return null;
      }
      return "failed";
    },
  });
  const closingSpace = useConfirmFlow<ClosingSpace>({
    // 最後の 1 つは残す。それ以外は、重複していなくても閉じられる。
    present: (target) => state !== null && canCloseSpace(state, target.workspaceId),
    request: (target) => closeWorkspace(target.workspaceId),
    settled: (_current, outcome) => (outcome === "done" ? null : "failed"),
  });

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
    removing.update((current) => (current?.phase === "leave" ? null : current));
  };

  // 削除の後も一覧の行を消えるアニメーションへ渡す間は、スナップショットの適用を
  // 止める。アニメーションの完了が届かない場合の保険を置く。
  const armRemovalFallback = () => {
    heldSnapshotTimer.current ??= window.setTimeout(finishRemoval, REMOVAL_LEAVE_FALLBACK_MS);
  };

  // 削除が確定したらダイアログを閉じ、一覧の対象を消えるアニメーションへ渡す。
  const beginRemovalLeave = () => {
    removing.update((current) => (current === null ? null : { ...current, phase: "leave" }));
    armRemovalFallback();
  };

  // 受信したスナップショットで丸ごと置き換える（docs/adr/bff-client-transport.md）。適用するか
  // 保留するかは snapshot-apply が決め、ここは決まった先の後始末だけを行う。
  const applyState = (next: AppState) => {
    const decision = decideSnapshotApply({
      next,
      removing: removing.latest.current,
      closing: closing.latest.current,
      leavingTab: leavingTabRef.current !== null,
      layout: splitRef.current.layout,
    });
    switch (decision.kind) {
      case "hold":
        heldSnapshot.current = next;
        return;
      case "leave-space":
        heldSnapshot.current = next;
        beginRemovalLeave();
        return;
      case "leave-tab":
        // ペインが無い以上 close の目的は達しているので、確認は閉じ、遅れて返る応答は捨てる。
        heldSnapshot.current = next;
        beginTabLeave(decision.paneId, decision.successor);
        closing.update(() => null);
        return;
      case "apply-now":
        heldSnapshot.current = null;
        closing.update(() => null);
        setState(next);
        return;
      case "apply":
        setState(next);
        return;
    }
  };

  // タブのアニメーションと削除のアニメーションがどちらも終わったら、保留した
  // スナップショットを 1 回だけ適用する。待つのは描画だけで、状態の正は BFF のまま。
  useEffect(() => {
    if (leavingTab !== null || removing.state?.phase === "leave") return;
    const held = heldSnapshot.current;
    if (held === null) return;
    heldSnapshot.current = null;
    // 保留中に別の対象が消えていれば、そのアニメーションへもう一度渡す。
    applyState(held);
  }, [leavingTab, removing.state?.phase]);

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
  const { size: codeSize, change: changeCodeSize } = useCodeFontSize();
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
  // 返すので表示は一覧に戻り、戻ってきたときは同じペインを開ける。タブとセルは
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
  // FLIP のキーは木の形とタブの並びだけで作り、active と current では動かさない。
  const splitKey = layoutKey(split.layout);
  // 保存は選択（current / active）も含める。FLIP は木の形とタブの並びだけで起こす。
  const persistKey = JSON.stringify(split);
  useEffect(() => {
    if (state === null) return;
    writeSplitView(split);
  }, [persistKey]);

  // ドロップやタブの反映の直前に位置を控え、変わったセルとタブを前の位置から滑らせる。
  const captureFlip = useFlipLayout(splitKey);

  // 表示する葉。広い画面は木の全部、狭い画面はフォーカス中の葉（無ければ最初）だけを
  // 1 セルとして投影する。他の葉は状態に残し、広い画面に戻ったときに復元する。
  const leaves = readingOrder(split.layout);
  const focused = leafOfPane(split.layout, split.current ?? "");
  const projected = focused ?? leaves[0] ?? null;
  const shownLeaves = wide ? leaves : projected === null ? [] : [projected];
  const splitCells = wide && leaves.length > 1;
  const compact = splitCells;
  // セルに描く木。広い画面は木の全部、狭い画面は 1 枚だけ。どちらも同じ部品へ渡す。
  // 分岐で部品を変えると、画面幅をまたいだ再描画でセルが作り直され、入力中の本文・
  // フォーカス・スクロール位置が消える。
  const cellRoot = wide ? split.layout : projected;

  // プレビューは一時タブのまま。対象のペインがどこかの葉にある間だけ、タブと本文に出せる。
  const {
    preview,
    previewInTab,
    previewing,
    open: openPreview,
    show: showPreview,
    hide: hidePreview,
    close: closePreview,
  } = usePreview({ state, openTabs: openTabs(split) });
  const previewLeaf = preview === null ? null : leafOfPane(split.layout, preview.paneId);

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
  const closingPane =
    state === null || closing.state === null ? null : findPane(state, closing.state.target.paneId);
  const removingTarget = removing.state?.target ?? null;
  const removingWorkspace =
    state === null || removingTarget === null
      ? null
      : (state.workspaces.find((workspace) => workspace.id === removingTarget.workspaceId) ?? null);

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
    fileTreeStore.clearPreview(paneId);
    moveTo(paneId, true);
  };

  const select = (paneId: string) => moveTo(paneId);

  // 一覧のツリーの行。タップは開くだけで、ドラッグの後は開かない。
  const selectFromList = (paneId: string) => {
    if (consumeDraggedClick()) return;
    // 開いているペインでも、ファイルのプレビューを閉じて会話へ戻す。
    fileTreeStore.clearPreview(paneId);
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

  // 閉じるアニメーションが終わったメニューを落とす。開き直していたら残す。
  const dropClosedMenu = () => setMenu((current) => (current?.open === false ? null : current));

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

  // 起動の記録と要求は hook が持つ。ここは、いま表示しているペインの起動の段階だけを読む。
  const { launches, beginLaunch, retryLaunch, useShell } = useLaunches({ state, now, skew });

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
      split: removeTab(splitRef.current, target.paneId, target.successor),
      expanded: expandedRef.current,
    });
  };

  const beginTabLeave = (paneId: string, successor?: string | null) => {
    const pending = leavingTabRef.current;
    if (pending !== null) {
      if (pending.paneId === paneId) return;
      finishTabLeave(pending.paneId);
    }
    if (leafOfPane(splitRef.current.layout, paneId) === null) return;
    const target = { paneId, successor };
    leavingTabRef.current = target;
    // 外すタブのボタンが消えると、ブラウザが隣のセルの操作要素へフォーカスを
    // 移すことがある。レイアウトの後継で current は決めるので、その短い間だけ
    // focusin を無視する。連続して外すときは期限を引き直す。
    clearFocusSuppression();
    suppressFocusActivation.current = true;
    suppressFocusTimer.current = window.setTimeout(clearFocusSuppression, FOCUS_SUPPRESS_MS);
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
    closing.open({ paneId, action, next: successorTab(split, paneId) });
  };

  const openCloseConfirm = () => {
    if (menu === null || menu.target.kind !== "pane") return;
    const paneId = menu.target.id;
    closeMenu();
    requestClose(paneId);
  };

  // チェックアウトの削除は取り消せない。Herdr の TUI と同じく、確認は 1 回だけにする。
  const openRemoveWorktreeConfirm = () => {
    if (menu === null || menu.target.kind !== "workspace" || state === null) return;
    const workspace = state.workspaces.find((item) => item.id === menu.target.id);
    if (workspace === undefined) return;
    // 削除できない対象（Herdr の作った linked worktree でない）なら開かない。
    // そのときはメニューも開いたままにして、別の操作を選べるようにする。
    const opened = removing.open({
      workspaceId: workspace.id,
      label: workspace.label,
      checkoutPath: workspace.worktree?.checkoutPath ?? null,
    });
    if (opened) closeMenu();
  };

  // 最後の 1 つは残す。それ以外は、重複していなくても閉じられる。
  const openCloseSpaceConfirm = () => {
    if (menu === null || menu.target.kind !== "workspace" || state === null) return;
    const workspace = state.workspaces.find((item) => item.id === menu.target.id);
    if (workspace === undefined) return;
    const opened = closingSpace.open({
      workspaceId: workspace.id,
      label: workspace.label,
      path: workspace.path ?? null,
    });
    if (opened) closeMenu();
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

  // シェルの前景プロセスは Herdr のイベントに載らない。各セルが表示しているペインと
  // current のシェルだけを読む。葉の全タブを読むと、3 秒ごとの要求が増える。
  const polledIds =
    state === null
      ? []
      : [
          ...new Set([...activePanes(split), ...(selectedPaneId === null ? [] : [selectedPaneId])]),
        ].filter((id) => findPane(state, id)?.agent === null);
  const processes = usePaneProcesses(polledIds);

  const { sidebarWidth, setSidebarWidth, saveSidebarWidth, drag } = useSidebarWidth();
  const { sidebarCollapsed, toggleSidebar } = useSidebarCollapsed();
  // 押したボタンは、閉じる側では inert な一覧の中に残り、開く側では DOM から外れて、焦点が
  // body に落ちる。ボタンで開閉したあとだけ、いま見えている側のボタンへ焦点を移す。
  const refocusToggle = useRef(false);
  const toggleSidebarFromButton = () => {
    refocusToggle.current = true;
    toggleSidebar();
  };
  useEffect(() => {
    if (!refocusToggle.current) return;
    refocusToggle.current = false;
    document
      .getElementById(sidebarCollapsed ? "hwc-sidebar-open" : "hwc-sidebar-close")
      ?.focus({ preventScroll: true });
  }, [sidebarCollapsed]);

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
    // ドラッグは広い画面だけで始まる。タブ列への差し込みは移動、セルは端なら分割、
    // 中央なら末尾への移動。
    const next =
      target.kind === "tab"
        ? moveTab(split, paneId, target.pane, target.side, target.gap)
        : dropOnPane(split, paneId, target.pane, target.zone);
    if (next === split) return;
    captureFlip();
    setView({ split: next, expanded });
  };
  const { dragging, startPaneDrag, startListPaneDrag, consumeDraggedClick } = usePaneDrag({
    wide,
    split: splitRef,
    onDrop: applyDrop,
  });

  // 掴んでいるタブの見出し。タブバーと同じ名前と、掴んだペインの葉の
  // スペース前置きを使い、掴んだものがそのまま付いてくるようにする。
  const draggedRow =
    state === null || dragging === null ? null : findPaneRow(state, dragging.paneId);
  const draggedLeaf =
    draggedRow === null || state === null ? null : leafOfPane(split.layout, draggedRow.pane.id);
  const draggedMultiSpace =
    draggedLeaf === null || state === null ? false : tabRows(state, draggedLeaf.tabs).multiSpace;
  const draggingLabel =
    draggedRow === null
      ? ""
      : tabLabelText(
          tabLabel(
            shortenSpaceName(draggedRow.workspace),
            shortenPaneName(
              paneTabName(draggedRow.pane, processes.get(draggedRow.pane.id) ?? null),
              draggedRow.workspace,
            ),
            draggedMultiSpace,
          ),
        );

  const leavingPaneId = leavingTab?.paneId ?? null;

  // メニューの中身は、開いている対象とスナップショットから導く。閉じていれば空。
  const menuItems = menuView({ state, menu, pullRequests, gitAction });
  const moveWorkspaceToTop = () => {
    const workspace = menuItems.workspace;
    if (workspace === null) return;
    moveToTopSeq.current += 1;
    setMoveToTop({ workspaceId: workspace.id, token: moveToTopSeq.current });
    closeMenu();
  };

  const cellContext: CellContext = {
    state,
    compact,
    wide,
    focused,
    parentPaneIds,
    menu,
    menuPaneId: menuItems.paneId,
    processes,
    leavingPaneId,
    entering,
    dragging,
    detailStatus,
    suppressFocusActivation,
    clearFocusSuppression,
    scheme,
    treeSide,
    treeWidth: fileTreeWidthPx(treeWidth),
    treeIcons,
    launches,
    now,
    workingSince,
    inputsInFlight: inputsInFlight.current,
    dismissedConfirmations,
    confirmationAttempts: confirmationAttempts.current,
    preview: { target: preview, inTab: previewInTab, previewing, leaf: previewLeaf },
  };
  const cellActions: CellActions = {
    select,
    selectFromTab,
    removeFromTabs,
    finishTabLeave,
    showPreview,
    closePreview,
    back,
    startPaneDrag,
    openPaneMenu,
    openWorkspaceMenu,
    send: sendToPane,
    stop: stopPane,
    startAgent: openStartAgentDialog,
    createSpace: openCreateSpaceDialog,
    retryLaunch,
    useShell,
    openImage: (url, name) => setViewer({ url, name }),
    openPreview,
    confirmFolderTrust: (paneId, id) => void confirmPaneFolderTrust(paneId, id),
    dismissConfirmation: (paneId, id) =>
      setDismissedConfirmations((current) => ({ ...current, [paneId]: id })),
    outputRef: (paneId, handle) => {
      if (handle === null) outputHandles.current.delete(paneId);
      else outputHandles.current.set(paneId, handle);
    },
  };

  const overlays: AppOverlaysProps = {
    dragging,
    draggingLabel,
    // メニューは中身と、その項目が呼ぶ操作を 1 つのまとまりで渡す。
    menu: {
      ...menuItems,
      operation: menu,
      dismiss: dismissMenu,
      close: closeMenu,
      exited: dropClosedMenu,
      openCreate: openCreateDialog,
      clearOutput: clearOutputForMenu,
      openCloseConfirm,
      openCreateWorktree: openCreateWorktreeDialog,
      openRemoveWorktree: openRemoveWorktreeConfirm,
      openCloseSpace: openCloseSpaceConfirm,
      moveToTop: moveWorkspaceToTop,
      runGitSync,
    },
    closing: { flow: closing, pane: closingPane },
    removing: { flow: removing, workspace: removingWorkspace },
    closingSpace: { flow: closingSpace },
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

  // 広い画面は詳細側の Placeholder が同じ案内を出すので、状態が届くまで一覧は出さない。
  // 狭い画面は一覧しか見えないので、そちらに案内を出す。
  const listHidden = wide && state === null;

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
        "--hwc-code-font-size": codeFontSize(codeSize),
      }}
    >
      <div class="hwc-body">
        {listHidden ? null : (
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
                openPaneMenuId={menu?.open === true && menu.fromList ? menuItems.paneId : null}
                openWorkspaceMenuId={menu?.open === true ? (menuItems.workspace?.id ?? null) : null}
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
                  removing.state === null
                    ? null
                    : {
                        workspaceId: removing.state.target.workspaceId,
                        phase: removing.state.phase,
                      }
                }
                onRemovalFinished={finishRemoval}
                workingSince={workingSince}
                finishedAt={finishedAt}
                pullRequests={pullRequests}
                now={now}
                onCollapse={wide && !settingsOpen ? toggleSidebarFromButton : null}
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
        )}

        {listHidden ? null : (
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
        )}

        {/* 畳んだ一覧を開くボタン。畳むと足元ごと画面外へ出るので、閉じるボタンとは別に詳細の左上へ出す。
            タブバーの中には置かない。空状態・読み込み中はタブバーが無く、畳んだまま開けなくなる。
            設定は左上が戻るボタンなので出さない。戻れば開くボタンがある。 */}
        {!listHidden && wide && sidebarCollapsed && !settingsOpen ? (
          <div class="hwc-sidebar-edge">
            <button
              type="button"
              id="hwc-sidebar-open"
              class="hwc-sidebar-toggle"
              aria-label="一覧を開く"
              aria-controls="hwc-sidebar"
              aria-expanded={!sidebarCollapsed}
              onClick={toggleSidebarFromButton}
            >
              <ChevronRightIcon size={20} />
            </button>
          </div>
        ) : null}

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
              codeSize={codeSize}
              onCodeSizeChange={changeCodeSize}
              revision={revision}
              connection={connection}
              wide={wide}
              onClose={() => setSettingsOpen(false)}
            />
          ) : state === null ? (
            <Placeholder connection={connection} />
          ) : split.layout !== null && shownLeaves.length > 0 ? (
            <div class="hwc-detail-inner">
              {previewing ? (
                <PreviewCell context={cellContext} actions={cellActions} />
              ) : (
                <div class="hwc-detail-grid" data-single={shownLeaves.length === 1}>
                  {cellRoot === null ? null : (
                    <CellTree
                      node={cellRoot}
                      parentDir={null}
                      context={cellContext}
                      actions={cellActions}
                    />
                  )}
                </div>
              )}
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
