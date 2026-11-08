import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type { AppState, PaneState } from "../server/herdr/state";
import { PaneDetail } from "./PaneDetail";
import { TabBar } from "./TabBar";
import { PaneList } from "./PaneList";
import { Settings } from "./Settings";
import {
  fetchRevision,
  fetchState,
  focusAgent,
  clearPaneOutput,
  closePane,
  confirmFolderTrust,
  parseAppState,
  removeWorktree,
  sendInput,
  stopAgent,
} from "./api";
import {
  INITIAL_CONNECTION,
  connectionAfter,
  connectionLabel,
  type ConnectionStatus,
} from "./connection";
import { CloseConfirm } from "./CloseConfirm";
import { CreatePane } from "./CreatePane";
import { ImageViewer } from "./ImageViewer";
import { CloseIcon, HwcMark, PlusIcon, SettingsIcon, TrashIcon } from "./icons";
import { Menu } from "./Menu";
import { PaneMenu } from "./PaneMenu";
import { usePaneProcesses } from "./process";
import { RemoveWorktreeConfirm } from "./RemoveWorktreeConfirm";
import type { PaneCommandHandle } from "./commands";
import type { ConfirmationAttempt } from "./confirmation";
import { MAX_PANES_PER_TAB } from "../shared/panes";
import { type PaneCloseAction, paneCloseAction } from "../shared/pane-close";
import { HIDDEN_STORAGE_KEY, parseHiddenPanes, toggleHiddenPanes } from "./hidden";
import {
  findPane,
  findPaneContext,
  findPaneRow,
  groupIds,
  initialExpanded,
  nextPaneInTab,
  splitPanes,
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
  readListOpen,
  readSelectedPane,
  restorePane,
  workspaceGroupIds,
  writeListOpen,
  writeSelectedPane,
} from "./selection";
import {
  LIST_SCOPE_STORAGE_KEY,
  parseListScope,
  pendingReadAfter,
  shouldFocusOnLeave,
  type ListScope,
} from "./scope";
import {
  SENT_PANE_STORAGE_KEY,
  parseSentPanes,
  recordSent,
  sentForSave,
  type SentPane,
} from "./sent";
import { gateSnapshot, nextObservation, type SnapshotOrigin } from "./snapshot";
import {
  FINISHED_AT_STORAGE_KEY,
  WORKING_SINCE_STORAGE_KEY,
  parseFinishedAt,
  parseWorkingSince,
  trackFinished,
  trackWorking,
  workingMs,
  workingSinceForSave,
} from "./time";
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

const SPLIT_STORAGE_KEY = "hwc-split";
const NO_GROUPS: ReadonlySet<string> = new Set();
const NO_TIMES: ReadonlyMap<string, number> = new Map();

// 保存に失敗しても表示は続ける。プライベートモードなどでは localStorage が使えない。
function readStored(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても、その場の表示は続ける。
  }
}

function writePaneTimes(key: string, times: Record<string, number>) {
  writeStored(key, JSON.stringify(times));
}

// 壁時計との同期。1 秒ごとに数え直し、稼働に入った時刻と完了した時刻は手元で覚える。
// 起点は端末にも残す。Herdr は変化の順序しか返さないので、こちらが唯一の持ち主になる。
// 復元は 1 回だけ。毎秒 localStorage を読む必要は無い。
function usePaneTimes(state: AppState | null, connection: ConnectionStatus) {
  const [now, setNow] = useState(() => Date.now());
  const restored = useRef(false);
  const workingSince = useRef<ReadonlyMap<string, number>>(NO_TIMES);
  const finishedAt = useRef<ReadonlyMap<string, number>>(NO_TIMES);
  // 観測済みのスナップショット。描き直しのたびに遷移を数えないよう、同じものは見ない。
  const observed = useRef<AppState | null>(null);
  // 次のスナップショットを新しい観測の最初として扱うか。判定は nextObservation が持つ。
  const fresh = useRef(true);

  if (!restored.current) {
    restored.current = true;
    workingSince.current = parseWorkingSince(readStored(WORKING_SINCE_STORAGE_KEY), now);
    finishedAt.current = parseFinishedAt(readStored(FINISHED_AT_STORAGE_KEY), now);
  }

  const newObservation = nextObservation(fresh.current, connection);
  fresh.current = newObservation;

  if (state !== null && observed.current !== state) {
    observed.current = state;
    const observing = !newObservation;
    fresh.current = false;

    // 完了時刻は、直前の観測で working だったペインが done / idle に移ったときだけ。
    const finished = trackFinished(finishedAt.current, workingSince.current, state, now, observing);
    if (finished !== finishedAt.current) {
      finishedAt.current = finished;
      writePaneTimes(FINISHED_AT_STORAGE_KEY, Object.fromEntries(finished));
    }

    const working = trackWorking(workingSince.current, state, now);
    if (working !== workingSince.current) {
      workingSince.current = working;
      writePaneTimes(WORKING_SINCE_STORAGE_KEY, workingSinceForSave(state, working));
    }
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return { workingSince: workingSince.current, finishedAt: finishedAt.current, now };
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

type View = { selectedPaneId: string | null; expanded: ReadonlySet<string> };

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

// 削除の確認。対象の名前とパスは開いた時点のスナップショットから取る。SSE が
// スペースを落とした後では、何を消すのかを引けない。
type Removing = {
  workspaceId: string;
  label: string;
  checkoutPath: string | null;
  phase: "confirm" | "busy" | "failed";
};

// 開き方の初期値は最初のスナップショットで決めて、以後の focus 移動には追従しない。
// 読んでいる途中で勝手に別のペインへ切り替わらないようにするため。
// 前回開いていたペインが残っていればそこへ戻す（再読み込みや HMR で先頭へ飛ばない）。
function defaultView(state: AppState, openGroups: ReadonlyMap<string, boolean> | null): View {
  const selectedPaneId = restorePane(state, readSelectedPane(), readListOpen());
  const remembered = openGroups ?? new Map();
  const base = applyOpenGroups(initialExpanded(state), remembered, groupIds(state));
  return {
    selectedPaneId,
    expanded:
      selectedPaneId === null ? base : expandForPane(state, selectedPaneId, base, remembered),
  };
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
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
  const [split, setSplit] = useState(() => {
    if (typeof localStorage === "undefined") return false;
    try {
      return localStorage.getItem(SPLIT_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() =>
    parseHiddenPanes(
      typeof localStorage === "undefined" ? null : localStorage.getItem(HIDDEN_STORAGE_KEY),
    ),
  );
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
  // 窓口はスペースごとに 1 つ。一覧が読む値なので state に置き、送信のたびに入れ替える。
  const [sent, setSent] = useState<ReadonlyMap<string, SentPane>>(() =>
    parseSentPanes(readStored(SENT_PANE_STORAGE_KEY)),
  );
  // メニューと確認はセルの外（App 直下）に 1 つだけ出す。セルは container-type を持ち、
  // 内側の fixed はセル基準になる。同時には 1 つだけ出し、Esc の購読を重ねない。
  const [menu, setMenu] = useState<OperationMenu | null>(null);
  // 会話と圧縮の状態は各詳細が持つ。一覧も同じ実行口を使う。
  const commandHandles = useRef(new Map<string, PaneCommandHandle>());
  // メニューや詳細の寿命でロックを失わず、次の描画より前の連打も抑える。
  // 正はこの集合だけにし、描画には変更通知を使う。
  const inputsInFlight = useRef(new Set<string>());
  const [, inputChanged] = useReducer((revision: number) => revision + 1, 0);
  // 結果不明の回答は再送できない。詳細の付け外しを越えて、この Map だけに試行状態を残す。
  const confirmationAttempts = useRef(new Map<string, ConfirmationAttempt>());
  const [, confirmationChanged] = useReducer((revision: number) => revision + 1, 0);
  const [closing, setClosing] = useState<Closing | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  // 作成ダイアログ。ワークツリーを作る場合は、モデル一覧の取得元になる起点スペースの ID も持つ。
  const [creating, setCreating] = useState<{
    paneId: string;
    worktreeWorkspaceId: string | null;
  } | null>(null);
  // 拡大中の画像。ダイアログはセルの containment の外（App 直下）に置く（ADR 0021）。
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);
  // 応答で受け取った新ペインは、スナップショットに現れてから開く。先に選ぶと一覧が一瞬出る。
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const closeInFlight = useRef(false);
  const removeInFlight = useRef(false);
  // 既読の保留。アクティブ一覧で開いたペインだけが入り、選択が離れた時点で判定する。
  const pendingRead = useRef<string | null>(null);

  // 状態の書き込み元は 1 つ。初回の fetch は SSE が最初のスナップショットを届けるまでの
  // つなぎで、届いた後は捨てる（遅れて返った古い応答で上書きしない）。
  const snapshotWriter = useRef<SnapshotOrigin>("initial-fetch");

  useEffect(() => {
    const controller = new AbortController();
    fetchState(controller.signal).then(
      (next) => {
        const decision = gateSnapshot(snapshotWriter.current, "initial-fetch");
        snapshotWriter.current = decision.writer;
        if (decision.apply) setState(next);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, []);

  // 受信したスナップショットで丸ごと置き換える。差分は適用しない（ADR 0005）。
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      const next = parseAppState(event.data);
      if (next === null) return;
      const decision = gateSnapshot(snapshotWriter.current, "stream");
      snapshotWriter.current = decision.writer;
      if (!decision.apply) return;
      setState(next);
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

  const toggleSplit = () => {
    setSplit((current) => {
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(SPLIT_STORAGE_KEY, String(!current));
        } catch {
          // 保存できなくてもその場の表示は変える。
        }
      }
      return !current;
    });
  };

  // 隠すのは分割の並びからだけ。Herdr の状態は変えない。
  const toggleHidden = (paneId: string) => {
    const next = toggleHiddenPanes(hidden, paneId);
    setHidden(next);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // 保存できなくてもその場の表示は変える。
      }
    }
  };

  // 一覧をどこまで出すかは端末ごとの見え方。Herdr 側には持たせない。
  const changeScope = (next: ListScope) => {
    setScope(next);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(LIST_SCOPE_STORAGE_KEY, next);
      } catch {
        // 保存できなくてもその場の表示は変える。
      }
    }
  };

  const { workingSince, finishedAt, now } = usePaneTimes(state, connection);

  // 選んだペインがスナップショットから消えても id は残す。findPane が null を返すので
  // 表示は一覧に戻り、戻ってきたときは同じペインを開ける。
  const selectedPaneId = view
    ? view.selectedPaneId
    : state
      ? (initialView.current ??= defaultView(state, openGroups.current)).selectedPaneId
      : null;
  const expanded = view
    ? view.expanded
    : state
      ? (initialView.current ??= defaultView(state, openGroups.current)).expanded
      : NO_GROUPS;

  const pane = state ? findPane(state, selectedPaneId) : null;

  // 画面に出ている選択をそのまま覚える（表示と保存を二重に持たない）。
  // 一覧に戻しているかは「一覧が出ているか」で決める。id を消すだけだと「まだ何も選んで
  // いない」と区別できず、開いていたペインが消えたときも再読み込みで別のチャットへ飛ぶ。
  useEffect(() => {
    if (state === null) return;
    writeSelectedPane(selectedPaneId);
    writeListOpen(pane === null);
  }, [state, selectedPaneId, pane]);
  const context = state ? findPaneContext(state, selectedPaneId) : null;
  // 確認の文言は状態を開いた時点で固定しない。ダイアログ中に変わればその値で読む。
  // スナップショットから消えたペインはもう無いので、確認は出さない。
  const closingPane = state === null || closing === null ? null : findPane(state, closing.paneId);
  const closingAvailable =
    state !== null && closing !== null && paneCloseAction(state, closing.paneId) === closing.action;
  const removingWorkspace =
    state === null || removing === null
      ? null
      : (state.workspaces.find((workspace) => workspace.id === removing.workspaceId) ?? null);
  const removingAvailable = removingWorkspace?.worktree?.isLinkedWorktree === true;

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
    nextExpanded: ReadonlySet<string> = expanded,
  ) => {
    const pending = pendingRead.current;
    if (pending !== null) {
      const status = state === null ? null : (findPane(state, pending)?.agentStatus ?? null);
      if (shouldFocusOnLeave(pending, paneId, status)) focusPane(pending);
    }
    pendingRead.current = pendingReadAfter(pending, paneId, opened);
    setPendingSelect(null);
    setView({ selectedPaneId: paneId, expanded: nextExpanded });
    setSettingsOpen(false);
  };

  // 保留を作るのはアクティブ一覧の行だけ。ツリー・詳細のタブバー・復元では作らない。
  const openActivePane = (paneId: string) => moveTo(paneId, true);

  const select = (paneId: string) => moveTo(paneId);

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

  // 開始時に表示していなくても、応答時点で表示されている詳細には読み直しを伝える。
  // 一覧でクリアを押し、通信待ち中に対象のペインを開く経路があるため。
  const clearOutputForMenu = async (paneId: string): Promise<boolean> => {
    const cleared = await clearPaneOutput(paneId);
    if (cleared) commandHandles.current.get(paneId)?.refreshOutput();
    return cleared;
  };

  const closeMenu = () => {
    // 送信中に別のメニューを開き直しても、古い応答で新しいメニューを閉じない。
    setMenu((current) =>
      current !== null && current === menu ? { ...current, open: false } : current,
    );
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
    if (workspace === undefined || workspace.worktree === null) return;
    if (workspace.worktree.isLinkedWorktree) return;
    const paneId = workspace.tabs.flatMap((tab) => tab.panes)[0]?.id;
    if (paneId === undefined) return;
    closeMenu();
    setCreating({ paneId, worktreeWorkspaceId: workspace.id });
  };

  // 確認を開く時点のスナップショットで、閉じたあとに選ぶペインを決めておく。
  const openCloseConfirm = () => {
    if (menu === null || menu.target.kind !== "pane" || state === null) return;
    const paneId = menu.target.id;
    const action = paneCloseAction(state, paneId);
    if (action === null || action === "keep") return;
    const row = findPaneRow(state, paneId);
    closeMenu();
    setClosing({
      paneId,
      action,
      next: row === null ? null : nextPaneInTab(row.tab.panes, paneId, hidden),
      phase: "confirm",
    });
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
      if (outcome !== "done") {
        setClosing((current) => (current === null ? null : { ...current, phase: "failed" }));
        return;
      }
      // 選んでいないペインを閉じても、読んでいるペインを動かさない。
      if (target.action === "close" && target.next !== null && selectedPaneId === target.paneId) {
        moveTo(target.next);
      }
      setClosing(null);
    });
  };

  // チェックアウトの削除は取り消せない。Herdr の TUI と同じく、確認は 1 回だけにする。
  const openRemoveWorktreeConfirm = () => {
    if (menu === null || menu.target.kind !== "workspace" || state === null) return;
    const workspace = state.workspaces.find((item) => item.id === menu.target.id);
    if (workspace === undefined || workspace.worktree?.isLinkedWorktree !== true) return;
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
  const confirmRemoveWorktree = () => {
    if (removing === null || removing.phase === "busy" || !removingAvailable) return;
    if (removeInFlight.current) return;
    removeInFlight.current = true;
    const target = removing;
    setRemoving({ ...target, phase: "busy" });
    void removeWorktree(target.workspaceId).then((outcome) => {
      removeInFlight.current = false;
      setRemoving((current) => {
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
    const next = new Set(expanded);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setView({ selectedPaneId, expanded: next });
    rememberOpen([groupId], next.has(groupId));
  };

  // 窓口は「最後に送ったペイン」。開いただけでは入れ替えないので、送信が通ったときだけ呼ぶ。
  const rememberSent = (paneId: string) => {
    if (state === null) return;
    const next = recordSent(sent, findPaneRow(state, paneId), Date.now());
    if (next === sent) return;
    setSent(next);
    writeStored(SENT_PANE_STORAGE_KEY, JSON.stringify(sentForSave(state, next)));
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
    rememberSent(paneId);
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

  // 詳細のタブバーは、選択中ペインが属するタブのペインだけを出す。
  const siblings = (() => {
    if (!state || !pane) return [];
    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) {
        if (tab.panes.some((candidate) => candidate.id === pane.id)) return tab.panes;
      }
    }
    return [];
  })();

  // シェルの前景プロセスは Herdr のイベントに載らない。見えているタブのシェルだけを読む。
  const shellPanes = siblings.filter((item) => item.agent === null);
  const processes = usePaneProcesses(shellPanes.map((item) => item.id));

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
    rememberOpen(workspaceGroupIds(workspace), true);
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

  // 分割は広い画面だけ。狭い画面では 1 枚ずつ見る。
  const shown = splitPanes(siblings, pane?.id ?? "", hidden);
  // 隠して 1 枚になってもグリッドを外さない。外すとペインの作り直しで
  // 読んでいた位置が最下部に戻る。
  const splitOn = wide && split && shown.length > 0;
  const cells = splitOn ? shown : pane === null ? [] : [pane];
  // 分割中は入力欄を 1 行に畳み、会話へ高さを回す。長文は 1 枚表示へ戻して書く（下書きは
  // ペインごとに残る）。幅や高さの閾値で切り替えると、境目の前後で見え方が変わり、なぜ
  // 畳まれないのかが画面から読み取れない。
  const compact = cells.length > 1;

  // 4 枚の判定は BFF と同じタブの枚数で行う。
  const menuPaneId = menu?.target.kind === "pane" ? menu.target.id : null;
  const menuTab = state === null ? null : (findPaneRow(state, menuPaneId)?.tab ?? null);
  const menuFull = menuTab !== null && menuTab.panes.length >= MAX_PANES_PER_TAB;
  const menuPane = state === null ? null : findPane(state, menuPaneId);
  const menuCloseAction =
    state === null || menuPaneId === null ? null : paneCloseAction(state, menuPaneId);
  const menuWorkspace =
    menu?.target.kind === "workspace"
      ? (state?.workspaces.find((workspace) => workspace.id === menu.target.id) ?? null)
      : null;
  // 一般のスペース作成は持たない。worktree.create で開くスペースだけを例外にする（ADR 0038）。
  const menuWorktree = menuWorkspace?.worktree ?? null;
  const canCreateWorktree = menuWorktree !== null && !menuWorktree.isLinkedWorktree;

  const renderPane = (item: PaneState, where: PaneContext, compact: boolean) => (
    <PaneDetail
      key={item.id}
      pane={item}
      context={where}
      compact={compact}
      scheme={scheme}
      // 名前はタブのチップと重なる。セルが並ぶときだけ、どのセルかを示すために出す。
      labeled={cells.length > 1}
      // ブランチは一覧が隠れる狭い画面でだけ出す。広い画面では一覧がブランチを持っている。
      branch={cells.length > 1 ? null : where.branch}
      // 広い画面でも PR のチップは見出しに出す。ブランチだけを隠す。
      showBranch={!wide}
      waitingMs={item.agentStatus === "working" ? workingMs(workingSince, item.id, now) : null}
      running={processes.get(item.id)?.running === true}
      sending={inputsInFlight.current.has(item.id)}
      dismissedConfirmation={dismissedConfirmations[item.id] ?? null}
      confirmationAttempts={confirmationAttempts.current}
      onConfirmFolderTrust={(id) => void confirmPaneFolderTrust(item.id, id)}
      onDismissConfirmation={(id) =>
        setDismissedConfirmations((current) => ({ ...current, [item.id]: id }))
      }
      menuOpen={menu?.open === true && !menu.fromList && menuPaneId === item.id}
      commandRef={(handle) => {
        if (handle === null) commandHandles.current.delete(item.id);
        else commandHandles.current.set(item.id, handle);
      }}
      onOpenMenu={openPaneMenu}
      onSubmit={(text, attachments) => sendToPane(item.id, text, attachments)}
      onStop={() => stopPane(item.id)}
      onOpenImage={(url, name) => setViewer({ url, name })}
    />
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
              scope={scope}
              onScope={changeScope}
              expanded={expanded}
              onSelect={select}
              onOpen={openActivePane}
              onRevealWorkspace={revealWorkspace}
              reveal={reveal}
              onToggle={toggle}
              openPaneMenuId={menu?.open === true && menu.fromList ? menuPaneId : null}
              openWorkspaceMenuId={menu?.open === true ? (menuWorkspace?.id ?? null) : null}
              onPaneMenu={(paneId, trigger) => openPaneMenu(paneId, trigger, true)}
              onWorkspaceMenu={(workspaceId, trigger) =>
                setMenu({
                  target: { kind: "workspace", id: workspaceId },
                  trigger,
                  fromList: true,
                  open: true,
                })
              }
              workingSince={workingSince}
              finishedAt={finishedAt}
              sent={sent}
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
          ) : pane && context ? (
            <div class="hwc-detail-inner">
              <TabBar
                pane={pane}
                panes={siblings}
                processes={processes}
                split={wide && split}
                hidden={hidden}
                status={detailStatus}
                onSelectPane={select}
                onToggleHidden={toggleHidden}
                onBack={back}
                onToggleSplit={toggleSplit}
              />
              {wide ? (
                <div class="hwc-split" data-count={cells.length}>
                  {cells.map((item) => (
                    <section class="hwc-split-cell" data-compact={compact} key={item.id}>
                      {renderPane(item, context, compact)}
                    </section>
                  ))}
                </div>
              ) : (
                renderPane(pane, context, false)
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

      {menu === null || (menuPane === null && menuWorkspace === null) ? null : (
        <Menu
          key={`${menu.target.kind}:${menu.target.id}`}
          label={`${menuWorkspace?.label ?? menuPaneId} の操作`}
          trigger={menu.trigger}
          open={menu.open}
          onClose={closeMenu}
          onExited={() => setMenu((current) => (current?.open === false ? null : current))}
          closeOnScroll={menu.fromList}
        >
          {menuPane === null ? null : (
            <PaneMenu
              pane={menuPane}
              full={menuFull}
              closeAction={menuCloseAction}
              commands={commandHandles.current.get(menuPane.id) ?? null}
              sending={inputsInFlight.current.has(menuPane.id)}
              onCreate={() => openCreateDialog(menuPane.id)}
              onClearOutput={() => clearOutputForMenu(menuPane.id)}
              onClosePane={openCloseConfirm}
              onDismiss={closeMenu}
              onSubmit={(text) => sendToPane(menuPane.id, text, [])}
            />
          )}
          {menuWorkspace === null ? null : (
            <>
              <p class="hwc-menu-head">{menuWorkspace.label}</p>
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
              {menuWorkspace.worktree?.isLinkedWorktree === true ? (
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

      {removing === null || removingWorkspace === null ? null : (
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

      {creating === null ? null : (
        <CreatePane
          paneId={creating.paneId}
          worktreeWorkspaceId={creating.worktreeWorkspaceId}
          onCreated={setPendingSelect}
          onClose={() => setCreating(null)}
        />
      )}

      {viewer === null ? null : (
        <ImageViewer url={viewer.url} name={viewer.name} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
