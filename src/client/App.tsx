import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import type { ChatFile } from "../server/chat/contract";
import type { AppState, PaneState } from "../server/herdr/state";
import { messageFileLabel } from "../shared/message-files";
import { PaneDetail } from "./PaneDetail";
import { attachmentStore } from "./attachment-store";
import { TabBar } from "./TabBar";
import { PaneList } from "./PaneList";
import { Settings } from "./Settings";
import {
  fetchRevision,
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
  stopAgent,
  syncWorkspace,
  type GitSyncFailure,
  type StateMessage,
} from "./api";
import {
  INITIAL_CONNECTION,
  connectionAfter,
  connectionLabel,
  type ConnectionStatus,
} from "./connection";
import { CloseConfirm } from "./CloseConfirm";
import { CloseSpaceConfirm } from "./CloseSpaceConfirm";
import { CreatePane } from "./CreatePane";
import { DragGhost, clearDragGhostPoint, setDragGhostPoint } from "./DragGhost";
import { applyFavicon, faviconStatus } from "./favicon";
import { ImageViewer } from "./ImageViewer";
import { Preview } from "./Preview";
import {
  ChevronRightIcon,
  CloseIcon,
  GitHubIcon,
  HwcMark,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
} from "./icons";
import { Menu } from "./Menu";
import { PaneMenu } from "./PaneMenu";
import { paneTabName, usePaneProcesses } from "./process";
import { useWorkspacePullRequests } from "./pull-request";
import { RemoveWorktreeConfirm } from "./RemoveWorktreeConfirm";
import { WorkspaceGitActions } from "./WorkspaceGitActions";
import { WorkspaceMenuHead } from "./WorkspaceMenuHead";
import type { PaneOutputHandle } from "./commands";
import type { ConfirmationAttempt } from "./confirmation";
import { MAX_PANES_PER_TAB } from "../shared/panes";
import { type PaneCloseAction, paneCloseAction } from "../shared/pane-close";
import {
  canCloseDuplicateSpace,
  findPane,
  findPaneContext,
  findPaneRow,
  groupIds,
  initialExpanded,
  markedParentPaneIds,
  tabDisplayName,
  type PaneContext,
} from "./select";
import {
  OPEN_GROUPS_STORAGE_KEY,
  applyOpenGroups,
  parseOpenGroups,
  rememberGroup,
} from "./expanded";
import {
  defaultPaneOf,
  expandForPane,
  expandForWorkspace,
  readSplitView,
  revealPane,
  revealPaneGroups,
  workspaceGroupIds,
  writeSplitView,
} from "./selection";
import {
  EMPTY_SPLIT_VIEW,
  canDrop,
  clearCurrent,
  currentSlotIndex,
  dropOnPane,
  leafPanes,
  multiSpace,
  nextOpenPane,
  normalizeSplitView,
  openPane,
  removeTab,
  startSplitView,
  syncSplitView,
  type DropZone,
  type SplitNode,
  type SplitView,
} from "./split-view";
import {
  LIST_SCOPE_STORAGE_KEY,
  parseListScope,
  pendingReadAfter,
  shouldFocusOnLeave,
  type ListScope,
} from "./scope";
import { gateSnapshot, type SnapshotOrigin } from "./snapshot";
import { type StartingPane, paneStarting } from "./starting";
import { clockSkew, serverClockNow, workingMs } from "./time";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_STEP,
  SIDEBAR_STORAGE_KEY,
  WIDE_LAYOUT_QUERY,
  clampSidebarWidth,
  parseSidebarWidth,
} from "./layout";
import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  themeScheme,
  type ThemePreference,
} from "./theme";

const NO_GROUPS: ReadonlySet<string> = new Set();
// スロット色を出さないときの並び。狭い画面は 4 色を使わない（ADR 0058）。
const NO_SLOTS: readonly (string | null)[] = [];
const NO_TIMES: ReadonlyMap<string, number> = new Map();

// 時刻は BFF が持つ。端末は受け取った時刻を並べるだけで、サーバーの時計に合わせた「今」で刻む。
function toTimes(record: Record<string, number> | undefined): ReadonlyMap<string, number> {
  return record === undefined ? NO_TIMES : new Map(Object.entries(record));
}

// 端末の幅は React の外にある。購読して、変わったときだけ描き直す。
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const apply = () => setMatches(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [query]);

  return matches;
}

type View = { split: SplitView; expanded: ReadonlySet<string> };

const NO_PARENT_PANE_IDS: ReadonlySet<string> = new Set();

// 開いているプレビュー。Herdr のペインではないので、状態には載せない。shown は
// タブの選択と同じで、ペインのタブを選ぶと false に戻る（ADR 0051）。
type PreviewTarget = { paneId: string; file: ChatFile; shown: boolean };

// 閉じる確認。後継は確認を開いた時点で決める。SSE が閉じたペインを落とした後では、
// 次のペインを引けないため。
type Closing = {
  paneId: string;
  action: PaneCloseAction;
  next: string | null;
  phase: "confirm" | "busy" | "failed";
};

type OperationMenu = {
  target: { kind: "pane" | "workspace"; id: string };
  trigger: HTMLElement;
  fromList: boolean;
  open: boolean;
};

// ドラッグの落とし先。中央は入れ替え、端はその方向への分割（ADR 0061）。
type DropTarget = { pane: string; zone: DropZone };

// クリックと区別する移動量。これ未満では掴んだだけで、選択も並べ替えも始めない。
const DRAG_THRESHOLD = 6;

// ポインタがセルのどこにあるか。親の分割軸と直交する向きだけを返す。
function dropZoneAt(cell: HTMLElement, x: number, y: number): DropZone {
  const rect = cell.getBoundingClientRect();
  const u = (x - rect.left) / rect.width;
  const v = (y - rect.top) / rect.height;
  const parent = cell.dataset.dropParent;
  if (parent === "row") return v < 0.32 ? "top" : v > 0.68 ? "bottom" : "center";
  if (parent === "col") return u < 0.32 ? "left" : u > 0.68 ? "right" : "center";
  // 親が無い単独セルは 4 方向。最も近い辺を選ぶ。
  const edges: readonly (readonly [DropZone, number])[] = [
    ["left", u],
    ["right", 1 - u],
    ["top", v],
    ["bottom", 1 - v],
  ];
  const nearest = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return nearest[1] < 0.3 ? nearest[0] : "center";
}

function dropTargetAt(x: number, y: number, source: string, view: SplitView): DropTarget | null {
  // ビューポートの外では何も返らない。掴んだまま画面外で離しただけで分割しない。
  const element = document.elementFromPoint(x, y);
  const cell = element?.closest("[data-drop-pane]");
  if (!(cell instanceof HTMLElement)) return null;
  const pane = cell.dataset.dropPane;
  if (pane === undefined) return null;
  const zone = dropZoneAt(cell, x, y);
  return canDrop(view, source, pane, zone) ? { pane, zone } : null;
}

// メニューを閉じても続く操作。busy はメニューの外に置き、開き直しても実行中を出す。
type GitAction =
  | { workspaceId: string; action: "fetch" | "pull"; phase: "busy" }
  | {
      workspaceId: string;
      action: "fetch" | "pull";
      phase: "failed";
      error: GitSyncFailure;
    };

// 削除の確認。対象の名前とパスは開いた時点のスナップショットから取る。SSE が
// スペースを落とした後では、何を消すのかを引けない。leave は削除が確定し、一覧から
// 対象が消えるアニメーションを見せている間。確認ダイアログは閉じる。
type Removing = {
  workspaceId: string;
  label: string;
  checkoutPath: string | null;
  phase: "confirm" | "busy" | "leave" | "failed";
};

// 一覧の行が消えるアニメーション（PaneList）の完了が届かない場合の保険。
// 待っている間も他の表示は止まるので、アニメーションより少し長い程度に留める。
const REMOVAL_LEAVE_FALLBACK_MS = 800;

// タブから外すアニメーション（TabBar）の対象。完了してから openTabs へ反映する。
// successor は閉じる確認で決めた後継。× では省略し、removeTab の既定に任せる。
type LeavingTab = { paneId: string; successor?: string | null };

// タブのアニメーションの完了が届かない場合の保険。SSE の適用もこの間だけ遅らせる。
const TAB_LEAVE_FALLBACK_MS = 400;

// 重複したネイティブスペースを閉じる確認。フォルダは残るが、実行中のエージェントは終わる。
type ClosingSpace = {
  workspaceId: string;
  label: string;
  path: string | null;
  phase: "confirm" | "busy" | "failed";
};

// 開き方の初期値は最初のスナップショットで決めて、以後の focus 移動には追従しない。
// 読んでいる途中で勝手に別のペインへ切り替わらないようにするため。
// 前回開いていたペインが残っていればそこへ戻す（再読み込みや HMR で先頭へ飛ばない）。
function defaultView(state: AppState, openGroups: ReadonlyMap<string, boolean> | null): View {
  const stored = readSplitView();
  const split =
    stored === null
      ? startSplitView(findPane(state, state.focusedPaneId) === null ? null : state.focusedPaneId)
      : normalizeSplitView(stored, (paneId) => findPane(state, paneId) !== null);
  const remembered = openGroups ?? new Map();
  const base = applyOpenGroups(initialExpanded(state), remembered, groupIds(state));
  return {
    split,
    expanded: split.current === null ? base : expandForPane(state, split.current, base, remembered),
  };
}

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
  const [revision, setRevision] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    parseSidebarWidth(
      typeof localStorage === "undefined" ? null : localStorage.getItem(SIDEBAR_STORAGE_KEY),
    ),
  );
  const [theme, setTheme] = useState<ThemePreference>(() =>
    loadThemePreference(typeof localStorage === "undefined" ? null : localStorage),
  );
  // 端末の外観は React の外にある。解決した明暗は、ANSI 色の補正と属性の両方で使う。
  const systemPrefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolvedTheme = resolveTheme(theme, systemPrefersDark);
  const scheme = themeScheme(resolvedTheme);
  // 分割のドラッグ。PC のポインタだけが起点で、押した時点の位置だけを控える。
  // listStart は一覧の行から始めたドラッグ。触れる画面では縦の動きをスクロールに譲る。
  const paneDrag = useRef<{
    paneId: string;
    x: number;
    y: number;
    active: boolean;
    listStart: boolean;
  } | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const [dragging, setDragging] = useState<{
    paneId: string;
    target: DropTarget | null;
  } | null>(null);
  // 最新の木をイベントから引く。ドラッグの購読は 1 度しか張らない。
  const splitRef = useRef<SplitView>(EMPTY_SPLIT_VIEW);
  // SSE の購読は 1 度しか張らないので、タブを外したあとの反映に使う一覧の
  // 開閉状態も ref から読む。
  const expandedRef = useRef<ReadonlySet<string>>(NO_GROUPS);
  // ドロップの前後で位置を比べるための控え（ADR 0061）。
  const flipRects = useRef<Map<string, DOMRect> | null>(null);
  // ドラッグ後の pointerup で click が成立しても、タブの選択を動かさない。
  const draggedSincePress = useRef(false);
  // 開閉の記憶は初期表示と切り替えのときだけ読む。描き直しには使わない。
  const openGroups = useRef<ReadonlyMap<string, boolean> | null>(null);
  openGroups.current ??= parseOpenGroups(
    typeof localStorage === "undefined" ? null : localStorage.getItem(OPEN_GROUPS_STORAGE_KEY),
  );
  const [scope, setScope] = useState<ListScope>(() =>
    parseListScope(
      typeof localStorage === "undefined" ? null : localStorage.getItem(LIST_SCOPE_STORAGE_KEY),
    ),
  );
  // 帯から「すべて」の場所へ移ったとき、一覧をその見出しまで送るための要求。
  // 同じ場所を何度も開けるよう、token で 1 回ずつ処理する。
  const [reveal, setReveal] = useState<{ workspaceId: string; token: number } | null>(null);
  const revealSeq = useRef(0);
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
  // 作成ダイアログ。ワークツリーを作る場合は、モデル一覧の取得元になる起点スペースの ID も持つ。
  const [creating, setCreating] = useState<{
    paneId: string;
    worktreeWorkspaceId: string | null;
  } | null>(null);
  // 拡大中の画像。ダイアログはセルの containment の外（App 直下）に置く（ADR 0021）。
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);
  // 開いているプレビュー。対象のペインは、そのタブを開いている間だけ出す。
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  // 応答で受け取った新ペインは、スナップショットに現れてから開く。先に選ぶと一覧が一瞬出る。
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  // 作ったばかりのペイン。エージェントが画面を引き継ぐまで、hwc からの入力を閉じる。
  // 開いているペインを切り替えても残す（選び直しでガードを外させない）。
  const [starting, setStarting] = useState<StartingPane | null>(null);
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
  // サーバーの時計と端末の時計の差。スナップショットを受けた場所で固定し、以後の描画では
  // ここに入れた値だけを使う。
  const skew = useRef(0);
  // 画面の「今」はサーバーの時計で刻む。状態が動かない間も経過が進むよう 1 秒ごとに描き直す。
  const [now, setNow] = useState(() => Date.now());
  const receive = (message: StateMessage) => {
    skew.current = clockSkew(message.now, Date.now(), skew.current);
    // 補正は次の刻みを待たない。待つと、状態が届いてから最初の刻みまで端末時計のずれだけ
    // 経過がずれて見える（非表示タブでは可視化後の最初の刻みまで残る）。
    setNow(serverClockNow(Date.now(), skew.current));
  };

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

  // 受信したスナップショットで丸ごと置き換える（ADR 0005）。画面から消える対象の
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
    // 達しているので、確認は閉じ、遅れて返る応答は捨てる（ADR 0021）。
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
    const timer = setInterval(() => setNow(serverClockNow(Date.now(), skew.current)), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchState(controller.signal).then(
      (message) => {
        receive(message);
        const decision = gateSnapshot(snapshotWriter.current, "initial-fetch");
        snapshotWriter.current = decision.writer;
        if (decision.apply) applyState(message.state);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, []);

  // 受信したスナップショットで丸ごと置き換える。差分は適用しない（ADR 0005）。
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      const message = parseAppState(event.data);
      if (message === null) return;
      receive(message);
      const decision = gateSnapshot(snapshotWriter.current, "stream");
      snapshotWriter.current = decision.writer;
      if (!decision.apply) return;
      applyState(message.state);
      setConnection(connectionAfter("snapshot"));
    };
    events.addEventListener("unavailable", () => setConnection(connectionAfter("unavailable")));
    // 再接続はブラウザに任せる。ここでは表示だけを切り替える。
    events.onerror = () => setConnection(connectionAfter("error"));
    return () => events.close();
  }, []);

  // どの版を見ているかを画面で確かめられるようにする。取れなくても表示だけ諦める。
  useEffect(() => {
    const controller = new AbortController();
    fetchRevision(controller.signal)
      .then((revision) => {
        if (revision !== null) setRevision(revision);
      })
      .catch(() => {
        // 取れないときはラベルを出さない。
      });
    return () => controller.abort();
  }, []);

  // 端末の外観に追従するかは利用者の選択で決まる。解決した結果だけを attribute に出す。
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.scheme = scheme;
  }, [resolvedTheme, scheme]);

  const changeTheme = (next: ThemePreference) => {
    setTheme(next);
    if (typeof localStorage !== "undefined") saveThemePreference(localStorage, next);
  };

  // 一覧をどこまで出すかは端末ごとの見え方。Herdr 側には持たせない。
  const changeScope = (next: ListScope) => {
    setReveal(null);
    setScope(next);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(LIST_SCOPE_STORAGE_KEY, next);
      } catch {
        // 保存できなくてもその場の表示は変える。
      }
    }
  };

  // 時刻は BFF が持つ。描画のたびに一度だけ Map へ引き直し、表示側の型は変えない。
  const workingSince = toTimes(state?.times.workingSince);
  const finishedAt = toTimes(state?.times.finishedAt);

  // タブのアイコンは、開いているペインではなく全スペースの親を見る。別タブにいても
  // 終わった親や質問に気付けるようにする。タイトルは変えない。
  const favicon = state === null ? null : faviconStatus(state);
  const parentPaneIds = state === null ? NO_PARENT_PANE_IDS : markedParentPaneIds(state);
  useEffect(() => applyFavicon(favicon), [favicon]);

  // 選んだペインがスナップショットから消えても id は残す（ADR 0021）。findPane が null を
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
  const splitKey = `${split.openTabs.join(" ")}\n${split.current ?? ""}\n${JSON.stringify(split.layout)}`;
  useEffect(() => {
    if (state === null) return;
    writeSplitView(split);
  }, [splitKey]);

  // ドロップで位置が変わったセルを、前の位置から滑らせる。分割で増えたセルは
  // フェードで入れる。初回表示とウィンドウのリサイズでは動かさない（ADR 0061）。
  useLayoutEffect(() => {
    const before = flipRects.current;
    flipRects.current = null;
    if (before === null || before.size === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const cell of document.querySelectorAll<HTMLElement>("[data-drop-pane]")) {
      const paneId = cell.dataset.dropPane;
      if (paneId === undefined) continue;
      const previous = before.get(paneId);
      if (previous === undefined) {
        cell.animate(
          [
            { opacity: 0, transform: "scale(0.985)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 160, easing: "cubic-bezier(.2, 0, 0, 1)" },
        );
        continue;
      }
      const now = cell.getBoundingClientRect();
      const dx = previous.left - now.left;
      const dy = previous.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      cell.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 200,
        easing: "cubic-bezier(.2, 0, 0, 1)",
      });
    }
  }, [splitKey]);

  // セルごとに文脈を引く。1 つの context を共有すると、別スペースを並べたときに
  // PR のチップや Git のメニューが別スペースの値になる。
  const context = state ? findPaneContext(state, selectedPaneId) : null;
  const openTabs =
    state === null
      ? []
      : split.openTabs.flatMap((paneId) => {
          const row = findPaneRow(state, paneId);
          return row === null ? [] : [row];
        });
  const multiSpaceTabs = multiSpace(openTabs.map((row) => row.workspace.id));

  // プレビューは一時タブのまま。開いた履歴にもスロットにも入れず、対象ペインが開いている
  // 間だけタブに出せる。ペインを選ぶと隠れる。
  const previewInTab = preview !== null && split.openTabs.includes(preview.paneId);
  const previewing = preview?.shown === true && previewInTab;

  // 閉じたペインのプレビューは残さない。配信の根が消えて、iframe は 404 になるだけ。
  useEffect(() => {
    if (preview === null || state === null) return;
    if (findPane(state, preview.paneId) === null) setPreview(null);
  }, [state, preview]);

  // ペインがスナップショットから消えたら、その添付と進行中のアップロードを捨てる。
  // ペインを切り替えただけでは捨てない（戻ってから送れるようにする）。
  useEffect(() => {
    if (state === null) return;
    attachmentStore.prune((paneId) => findPane(state, paneId) !== null);
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
    canCloseDuplicateSpace(state, closingSpace.workspaceId);

  // 既読は Herdr の seen を進めて消す。失敗しても通知しない。次にその行を開いて離れたときに
  // もう一度送られるので、ここで知らせても利用者にできることが無い。
  const focusPane = (paneId: string) => {
    focusAgent(paneId).catch(() => {
      // best-effort。選択は既に成立している。
    });
  };

  // 選択の変更は必ずここを通す。保留中の既読は、そのペインを離れる時点で done なら送る。
  // 開いた時点で送らないので、読んでいる間は行が残る。保留は state にしない（再描画しない）。
  // 同じペインへの移動（詳細のタブバーやツリーでの選び直し）はまだ離れていないので、保留を残す。
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
    // ペインのタブを選んだら、プレビューは閉じずに隠す。閉じるのはプレビュー自身の操作。
    setPreview((current) =>
      current === null || !current.shown ? current : { ...current, shown: false },
    );
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

  // ドラッグが成立した後の click で選択を動かさない。次の押下で解除する。
  const consumeDraggedClick = (): boolean => {
    if (!draggedSincePress.current) return false;
    draggedSincePress.current = false;
    return true;
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
    setCreating({ paneId, worktreeWorkspaceId: null });
    closeMenu();
  };

  // ワークツリーはリポジトリ本体のスペースからだけ作る。モデル一覧は起点スペースの先頭ペイン
  // から読み、起動時の再検証は新しい root pane の cwd で BFF が行う。
  const openCreateWorktreeDialog = () => {
    if (menu === null || menu.target.kind !== "workspace" || state === null) return;
    const workspace = state.workspaces.find((item) => item.id === menu.target.id);
    if (workspace === undefined || workspace.worktree?.managed !== true) return;
    if (workspace.worktree.isLinkedWorktree) return;
    const paneId = workspace.tabs.flatMap((tab) => tab.panes)[0]?.id;
    if (paneId === undefined) return;
    closeMenu();
    setCreating({ paneId, worktreeWorkspaceId: workspace.id });
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
    if (!splitRef.current.openTabs.includes(paneId)) return;
    const target = { paneId, successor };
    leavingTabRef.current = target;
    setLeavingTab(target);
    leaveTabTimer.current = window.setTimeout(() => finishTabLeave(paneId), TAB_LEAVE_FALLBACK_MS);
  };

  // タブの × はタブから外すだけ。ペインは閉じず、Herdr 側で動き続ける（ADR 0059）。
  const removeFromTabs = (paneId: string) => beginTabLeave(paneId);

  // プレビューのタブとヘッダーの × は同じ入口にする。どちらも画面から外すだけで、
  // チップはメッセージに残る（ADR 0051）。
  const closePreview = () => setPreview(null);

  // 確認を開く時点のスナップショットで、閉じたあとに選ぶペインを決めておく。SSE が
  // 閉じたペインを落とした後では、後継を引けない。
  const requestClose = (paneId: string) => {
    if (state === null) return;
    const action = paneCloseAction(state, paneId);
    if (action === null || action === "keep") return;
    setClosing({
      paneId,
      action,
      next: nextOpenPane(split.openTabs, paneId),
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
      // 応答より先に対象が消えていた場合は、削除済みとして扱う（ADR 0034）。
      if (removingRef.current?.phase === "leave") {
        finishRemoval();
        return;
      }
      setRemoving((current) => (current === null ? null : { ...current, phase: "failed" }));
    });
  };

  // 同じ場所のスペースが 2 つ以上あるときだけ、最後の 1 つを残して閉じられる。
  const openCloseSpaceConfirm = () => {
    if (menu === null || menu.target.kind !== "workspace" || state === null) return;
    const workspace = state.workspaces.find((item) => item.id === menu.target.id);
    if (workspace === undefined || !canCloseDuplicateSpace(state, workspace.id)) return;
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

  // 開閉は次に開いたときも同じにしたいので、既定からの差分として覚える。
  const rememberOpen = (groupIds: readonly string[], open: boolean) => {
    let remembered = openGroups.current ?? new Map<string, boolean>();
    for (const groupId of groupIds) remembered = rememberGroup(remembered, groupId, open);
    openGroups.current = remembered;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(
          OPEN_GROUPS_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(remembered)),
        );
      } catch {
        // 保存できなくてもその場の表示は変える。
      }
    }
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

  // 画面が狭くなったら一覧も詰める。詳細が読めない幅にはしない。
  useEffect(() => {
    const fit = () => setSidebarWidth((width) => clampSidebarWidth(width, window.innerWidth));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const saveSidebarWidth = (width: number) => {
    const clamped = clampSidebarWidth(width, window.innerWidth);
    setSidebarWidth(clamped);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(clamped));
      } catch {
        // 保存できなくてもその場の幅は変える。
      }
    }
  };

  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);

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

  const connChip = (
    <span class="hwc-conn" data-status={connection}>
      <span class="hwc-conn-dot" />
      {connectionLabel(connection)}
    </span>
  );

  const actions = (
    <>
      {connChip}
      <button
        type="button"
        class="hwc-icon-button hwc-foot-button"
        aria-label={settingsOpen ? "設定を閉じる" : "設定"}
        onClick={() => setSettingsOpen((open) => !open)}
      >
        {settingsOpen ? <CloseIcon /> : <SettingsIcon />}
      </button>
    </>
  );

  // 接続は一覧の足元に出す。チャットは狭い画面で足元が隠れるので、タブバーの右端に
  // 異常のときだけ出す。正常な間は何も出さず、タブの幅を空けておく。
  const detailStatus = wide || connection === "live" ? null : connChip;

  // 掴んでいるタブの見出し。タブバーと同じ名前を使い、掴んだものがそのまま付いてくるようにする。
  const draggedRow =
    state === null || dragging === null ? null : findPaneRow(state, dragging.paneId);
  const draggingLabel =
    draggedRow === null
      ? ""
      : tabDisplayName(
          paneTabName(draggedRow.pane, processes.get(draggedRow.pane.id) ?? null),
          draggedRow.workspace,
        );

  // ドラッグの適用先。タブとセルの両方から掴むので、最新の状態を持つ関数を ref に置く。
  const captureFlip = () => {
    const rects = new Map<string, DOMRect>();
    for (const cell of document.querySelectorAll<HTMLElement>("[data-drop-pane]")) {
      const paneId = cell.dataset.dropPane;
      if (paneId !== undefined) rects.set(paneId, cell.getBoundingClientRect());
    }
    flipRects.current = rects;
  };
  const applyDrop = (paneId: string, target: DropTarget) => {
    const next = dropOnPane(split, paneId, target.pane, target.zone);
    if (next === split) return;
    captureFlip();
    setView({ split: next, expanded });
  };
  const applyDropLatest = useRef(applyDrop);
  applyDropLatest.current = applyDrop;

  // タブ・セル・一覧の行の押下だけを控え、動き始めてからドラッグにする。クリックとの
  // 競合を移動量で分ける（一覧の並べ替えと同じ判定）。
  const startPaneDrag = (event: PointerEvent, paneId: string, listStart = false) => {
    if (!wide || event.button !== 0) return;
    paneDrag.current = {
      paneId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      listStart,
    };
    draggedSincePress.current = false;
  };

  const startListPaneDrag = (event: PointerEvent, paneId: string) => {
    startPaneDrag(event, paneId, true);
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const dragState = paneDrag.current;
      if (dragState === null) return;
      if (!dragState.active) {
        const dx = event.clientX - dragState.x;
        const dy = event.clientY - dragState.y;
        // 一覧は縦にスクロールする。触れる画面では、縦の動きをスクロールに譲り、
        // セルの方へ向かう横の動きだけをドラッグの開始とみなす。
        if (dragState.listStart && event.pointerType !== "mouse" && Math.abs(dx) <= Math.abs(dy)) {
          return;
        }
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        dragState.active = true;
        draggedSincePress.current = true;
      }
      event.preventDefault();
      setDragGhostPoint(event.clientX, event.clientY);
      dropTargetRef.current = dropTargetAt(
        event.clientX,
        event.clientY,
        dragState.paneId,
        splitRef.current,
      );
      setDragging({ paneId: dragState.paneId, target: dropTargetRef.current });
    };
    const onEnd = () => {
      const dragState = paneDrag.current;
      paneDrag.current = null;
      if (dragState === null || !dragState.active) return;
      const target = dropTargetRef.current;
      dropTargetRef.current = null;
      clearDragGhostPoint();
      setDragging(null);
      if (target !== null) applyDropLatest.current(dragState.paneId, target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      clearDragGhostPoint();
    };
  }, []);

  // グリッドは木の葉。空きは持たない（ADR 0061）。
  const layoutPanes = leafPanes(split.layout);
  // 現在ペインが入っているスロット（1 始まり）。一覧の現在行とタブの色に使う。
  const currentSlot = currentSlotIndex(split);
  // セルが並ぶのは広い画面だけ。狭い画面は 1 枚表示なので、分割セル向けの表示を切り替える。
  const splitCells = wide && layoutPanes.length > 1;
  // グリッドは広い画面で、current が実在するときだけ出す。
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
  // 一般のスペース作成は持たない。worktree.create で開くスペースだけを例外にする（ADR 0038）。
  const menuWorktree = menuWorkspace?.worktree ?? null;
  const canCreateWorktree = menuWorktree?.managed === true && !menuWorktree.isLinkedWorktree;
  const menuCanCloseSpace =
    state !== null && menuWorkspace !== null && canCloseDuplicateSpace(state, menuWorkspace.id);

  const renderPane = (item: PaneState, where: PaneContext, compact: boolean) => (
    <PaneDetail
      key={item.id}
      pane={item}
      context={where}
      compact={compact}
      scheme={scheme}
      // 名前はタブのチップと重なる。セルが並ぶときだけ、どのセルかを示すために出す。
      labeled={splitCells}
      // 複数スペースのペインが並ぶときだけ、見出しにスペース名を添える（ADR 0019）。
      showSpace={splitCells && multiSpaceTabs}
      // ブランチの文字は一覧が隠れる狭い画面でだけ出す。分割セルでも PR のチップを引くため、
      // 値そのものは常に渡す。
      branch={where.branch}
      // 上流との差はワークスペースの属性。セルが並ぶときは同じ値が並ぶので出さない。
      sync={splitCells ? null : where.sync}
      workspaceMenuOpen={
        menu?.open === true &&
        menu.target.kind === "workspace" &&
        menu.target.id === where.workspaceId
      }
      // 広い画面でも PR のチップは見出しに出す。ブランチだけを隠す。
      showBranch={!wide}
      waitingMs={item.agentStatus === "working" ? workingMs(workingSince, item.id, now) : null}
      running={processes.get(item.id)?.running === true}
      sending={inputsInFlight.current.has(item.id)}
      starting={paneStarting(starting, item, now)}
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
      onOpenImage={(url, name) => setViewer({ url, name })}
      onOpenPreview={(file) => setPreview({ paneId: item.id, file, shown: true })}
    />
  );

  // ドラッグ中のプレビューの文言。中央は木の中なら入れ替え、外のタブなら置換。
  const dropLabel = (zone: DropZone, moving: string | null): string => {
    if (zone !== "center") {
      return { top: "上に追加", bottom: "下に追加", left: "左に追加", right: "右に追加" }[zone];
    }
    return moving !== null && layoutPanes.includes(moving) ? "ここで入れ替え" : "この位置に表示";
  };

  // セルは木の葉。親の分割軸を data 属性に置き、ドラッグ中の向き判定に使う（ADR 0061）。
  const renderCell = (paneId: string, parentDir: "row" | "col" | null) => {
    if (state === null) return null;
    const item = findPane(state, paneId);
    if (item === null) return null;
    const where = findPaneContext(state, paneId);
    // クリックしたセルを current にする。Herdr のフォーカスに追従させると、
    // HWC から動かせないセルが current のままになる。
    const activate = () => {
      if (item.id !== pane?.id) select(item.id);
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
    const target = dragging?.target?.pane === item.id ? dragging.target : null;
    return (
      <section
        class="hwc-split-cell"
        data-slot={layoutPanes.indexOf(item.id) + 1}
        data-compact={compact}
        data-current={item.id === pane?.id}
        data-drop-pane={item.id}
        data-drop-parent={parentDir ?? undefined}
        data-leaving={leavingTab?.paneId === item.id ? "true" : undefined}
        key={item.id}
        onPointerDown={(event) => {
          activate();
          dragFromHead(event);
        }}
        onFocusIn={activateFromFocus}
      >
        {where === null ? null : renderPane(item, where, compact)}
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

  const listPlaceholder = (
    <div class="hwc-empty">
      <div class="hwc-empty-mark">
        <HwcMark size={32} />
      </div>
      <h2 class="hwc-empty-title">
        {connection === "unavailable" ? "Herdr に接続できません" : "接続中"}
      </h2>
      <p class="hwc-empty-text">
        {connection === "unavailable"
          ? "Herdr が起動しているか確かめてください。"
          : "ペインの一覧を受け取っています。"}
      </p>
    </div>
  );

  const placeholder = (
    <div class="hwc-empty hwc-empty--detail">
      <div class="hwc-empty-mark hwc-empty-mark--app">
        <HwcMark size={40} />
      </div>
      <h2 class="hwc-empty-title">
        {connection === "unavailable" ? "Herdr に接続できません" : "接続中"}
      </h2>
      <p class="hwc-empty-text">
        {connection === "unavailable"
          ? "Herdr が起動しているか確かめてください。接続が戻ると自動で表示されます。"
          : "Herdr の状態を受け取っています。"}
      </p>
    </div>
  );

  return (
    <div
      class="hwc-app"
      data-view={settingsOpen ? "settings" : pane ? "detail" : "list"}
      style={{ "--hwc-sidebar-width": `${sidebarWidth}px` }}
    >
      <div class="hwc-body">
        <aside class="hwc-list" aria-label="ペイン一覧">
          {state === null ? (
            listPlaceholder
          ) : (
            <PaneList
              state={state}
              selectedPaneId={selectedPaneId}
              // スロット色は PC だけ。狭い画面ではタブ履歴と 2 段目だけを出す（ADR 0058）。
              currentSlot={wide && currentSlot >= 0 ? currentSlot + 1 : null}
              parentPaneIds={parentPaneIds}
              scope={scope}
              onScope={changeScope}
              expanded={expanded}
              onSelect={selectFromList}
              onOpen={openActivePane}
              onDragStart={startListPaneDrag}
              onRevealWorkspace={revealWorkspace}
              reveal={reveal}
              onToggle={toggle}
              openPaneMenuId={menu?.open === true && menu.fromList ? menuPaneId : null}
              openWorkspaceMenuId={menu?.open === true ? (menuWorkspace?.id ?? null) : null}
              onPaneMenu={(paneId, trigger) => openPaneMenu(paneId, trigger, true)}
              onWorkspaceMenu={(workspaceId, trigger) =>
                openWorkspaceMenu(workspaceId, trigger, true)
              }
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
              <span class="hwc-foot-name">HWC</span>
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

        <main class="hwc-detail">
          {settingsOpen ? (
            <Settings
              key="settings"
              theme={theme}
              onThemeChange={changeTheme}
              revision={revision}
              connection={connection}
              onClose={() => setSettingsOpen(false)}
            />
          ) : state === null ? (
            placeholder
          ) : (wide && openTabs.length > 0) || pane !== null ? (
            <div class="hwc-detail-inner">
              <TabBar
                openTabs={openTabs}
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
                onSelectPreview={() =>
                  setPreview((current) => (current === null ? null : { ...current, shown: true }))
                }
                onClosePreview={closePreview}
                onBack={back}
                onDragStart={startPaneDrag}
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
                  renderPane(pane, context, false)
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

      {closing === null || closingPane === null ? null : (
        <CloseConfirm
          pane={closingPane}
          action={closing.action}
          available={closingAvailable}
          busy={closing.phase === "busy"}
          failed={closing.phase === "failed"}
          onConfirm={confirmClose}
          onCancel={cancelClose}
        />
      )}

      {removing === null || removing.phase === "leave" || removingWorkspace === null ? null : (
        <RemoveWorktreeConfirm
          label={removing.label}
          checkoutPath={removing.checkoutPath}
          available={removingAvailable}
          busy={removing.phase === "busy"}
          failed={removing.phase === "failed"}
          onConfirm={confirmRemoveWorktree}
          onCancel={cancelRemoveWorktree}
        />
      )}

      {closingSpace === null ? null : (
        <CloseSpaceConfirm
          label={closingSpace.label}
          path={closingSpace.path}
          available={closingSpaceAvailable}
          busy={closingSpace.phase === "busy"}
          failed={closingSpace.phase === "failed"}
          onConfirm={confirmCloseSpace}
          onCancel={cancelCloseSpace}
        />
      )}

      {creating === null ? null : (
        <CreatePane
          paneId={creating.paneId}
          worktreeWorkspaceId={creating.worktreeWorkspaceId}
          onCreated={(paneId, agent) => {
            setPendingSelect(paneId);
            // エージェントを起動しなかった（シェル・起動失敗）ペインは、すぐに入力できる。
            setStarting(agent ? { paneId, at: serverClockNow(Date.now(), skew.current) } : null);
          }}
          onClose={() => setCreating(null)}
        />
      )}

      {viewer === null ? null : (
        <ImageViewer url={viewer.url} name={viewer.name} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
