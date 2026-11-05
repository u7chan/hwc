import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState, PaneState } from "../server/herdr/state";
import { PaneDetail } from "./PaneDetail";
import { TabBar } from "./TabBar";
import { PaneList } from "./PaneList";
import { Settings } from "./Settings";
import {
  fetchRevision,
  fetchState,
  focusAgent,
  closePane,
  parseAppState,
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
import { CloseIcon, CollapseIcon, HwcMark, NewSessionIcon, PlusIcon, SettingsIcon } from "./icons";
import { MENU_HEIGHT, Menu, menuPlacement, type MenuPlacement } from "./Menu";
import { commandLabel, isCommandPane, type CommandId, type PaneCommandHandle } from "./commands";
import { MAX_PANES_PER_TAB } from "../shared/panes";
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
  expandForPane,
  readListOpen,
  readSelectedPane,
  restorePane,
  writeListOpen,
  writeSelectedPane,
} from "./selection";
import { LIST_SCOPE_STORAGE_KEY, parseListScope, type ListScope } from "./scope";
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
  type ThemePreference,
} from "./theme";

const SPLIT_STORAGE_KEY = "hwc-split";
const NO_GROUPS: ReadonlySet<string> = new Set();
const NO_TIMES: ReadonlyMap<string, number> = new Map();
// 詳細のメニューは見出し + 項目 4 つ + 区切り + 注記行。位置計算のための目安。
const DETAIL_MENU_HEIGHT = MENU_HEIGHT + 44 * 4;

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
  next: string | null;
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
  const [revision, setRevision] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    parseSidebarWidth(
      typeof localStorage === "undefined" ? null : localStorage.getItem(SIDEBAR_STORAGE_KEY),
    ),
  );
  const [theme, setTheme] = useState<ThemePreference>(() =>
    loadThemePreference(typeof localStorage === "undefined" ? null : localStorage),
  );
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
  // 窓口はスペースごとに 1 つ。一覧が読む値なので state に置き、送信のたびに入れ替える。
  const [sent, setSent] = useState<ReadonlyMap<string, SentPane>>(() =>
    parseSentPanes(readStored(SENT_PANE_STORAGE_KEY)),
  );
  // メニューと確認はセルの外（App 直下）に 1 つだけ出す。セルは container-type を持ち、
  // 内側の fixed はセル基準になる。同時には 1 つだけ出し、Esc の購読を重ねない。
  const [menu, setMenu] = useState<
    ({ paneId: string; commands: PaneCommandHandle } & MenuPlacement) | null
  >(null);
  const [closing, setClosing] = useState<Closing | null>(null);
  // 作成ダイアログの対象ペイン。空なら閉じている。
  const [createTarget, setCreateTarget] = useState<string | null>(null);
  // 応答で受け取った新ペインは、スナップショットに現れてから開く。先に選ぶと一覧が一瞬出る。
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const closeInFlight = useRef(false);

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
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme, media.matches);
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

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

  // 新ペインがスナップショットに現れたら開く。応答の前に SSE が届いていれば、ここで 1 度だけ動く。
  useEffect(() => {
    if (pendingSelect === null || state === null) return;
    if (findPane(state, pendingSelect) === null) return;
    setView({ selectedPaneId: pendingSelect, expanded });
    setPendingSelect(null);
  }, [state, pendingSelect, expanded]);

  const select = (paneId: string) => {
    setPendingSelect(null);
    setView({ selectedPaneId: paneId, expanded });
    setSettingsOpen(false);
  };

  // 既読は Herdr の seen を進めて消す。失敗しても通知しない。次にその行を開いたときに
  // もう一度送られるので、ここで知らせても利用者にできることが無い。
  const focusPane = (paneId: string) => {
    focusAgent(paneId).catch(() => {
      // best-effort。選択は既に成立している。
    });
  };

  const back = () => {
    setPendingSelect(null);
    setView({ selectedPaneId: null, expanded });
  };

  const openPaneMenu = (paneId: string, rect: DOMRect, commands: PaneCommandHandle) => {
    const placement = menuPlacement(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      DETAIL_MENU_HEIGHT,
    );
    setMenu({ paneId, commands, ...placement });
  };

  const closeMenu = () => setMenu(null);

  const runPaneCommand = (id: CommandId) => {
    if (menu === null) return;
    setMenu(null);
    menu.commands.run(id);
  };

  // 名前とエージェントはダイアログで決める。メニューは入口だけ。
  const openCreateDialog = () => {
    if (menu === null) return;
    setCreateTarget(menu.paneId);
    setMenu(null);
  };

  // 確認を開く時点のスナップショットで、閉じたあとに選ぶペインを決めておく。
  const openCloseConfirm = () => {
    if (menu === null) return;
    const paneId = menu.paneId;
    const row = state === null ? null : findPaneRow(state, paneId);
    setMenu(null);
    setClosing({
      paneId,
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
    if (closing === null || closing.phase === "busy") return;
    if (closeInFlight.current) return;
    closeInFlight.current = true;
    const target = closing;
    setClosing({ ...target, phase: "busy" });
    void closePane(target.paneId).then((outcome) => {
      closeInFlight.current = false;
      if (outcome !== "done") {
        setClosing((current) => (current === null ? null : { ...current, phase: "failed" }));
        return;
      }
      // 選んでいないペインを閉じても、読んでいるペインを動かさない。
      if (target.next !== null && selectedPaneId === target.paneId) {
        setView({ selectedPaneId: target.next, expanded });
      }
      setClosing(null);
    });
  };

  // 開閉は次に開いたときも同じにしたいので、既定からの差分として覚える。
  const toggle = (groupId: string) => {
    const next = new Set(expanded);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setView({ selectedPaneId, expanded: next });

    const remembered = rememberGroup(openGroups.current ?? new Map(), groupId, next.has(groupId));
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

  // 窓口は「最後に送ったペイン」。開いただけでは入れ替えないので、送信が通ったときだけ呼ぶ。
  const rememberSent = (paneId: string) => {
    if (state === null) return;
    const next = recordSent(sent, findPaneRow(state, paneId), Date.now());
    if (next === sent) return;
    setSent(next);
    writeStored(SENT_PANE_STORAGE_KEY, JSON.stringify(sentForSave(state, next)));
  };

  // 送れたかどうかを返す。失敗したら入力欄が下書きを残せるようにする。
  // 失敗の表示は入力欄を持つ PaneDetail が持つ。ペインを離れれば消える。
  const sendToPane = async (
    paneId: string,
    text: string,
    attachments: string[],
  ): Promise<boolean> => {
    try {
      await sendInput(paneId, text, attachments);
    } catch {
      return false;
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
  const menuTab =
    state === null || menu === null ? null : (findPaneRow(state, menu.paneId)?.tab ?? null);
  const menuFull = menuTab !== null && menuTab.panes.length >= MAX_PANES_PER_TAB;
  const menuPane = state === null || menu === null ? null : findPane(state, menu.paneId);
  const menuCommands = menu?.commands ?? null;
  const menuCommandsShown = menuPane !== null && isCommandPane(menuPane);
  const menuCommandsBusy = menuPane?.agentStatus === "working" || (menuCommands?.busy() ?? false);
  const canRunNew =
    menuCommandsShown && menuPane !== null && (menuCommands?.available("new", menuPane) ?? false);
  const canRunCompact =
    menuCommandsShown &&
    menuPane !== null &&
    (menuCommands?.available("compact", menuPane) ?? false);
  // working / 送信中ではなく、compact だけが使えない理由は履歴の小ささ。
  const compactBlockedByHistory =
    menuCommandsShown && menuCommands !== null && !menuCommandsBusy && !canRunCompact;

  const renderPane = (item: PaneState, where: PaneContext, compact: boolean) => (
    <PaneDetail
      key={item.id}
      pane={item}
      context={where}
      compact={compact}
      // 名前はタブのチップと重なる。セルが並ぶときだけ、どのセルかを示すために出す。
      labeled={cells.length > 1}
      // ブランチは一覧が隠れる狭い画面でだけ出す。広い画面の一覧と分割のセルでは重なる。
      branch={wide || cells.length > 1 ? null : where.branch}
      waitingMs={item.agentStatus === "working" ? workingMs(workingSince, item.id, now) : null}
      menuOpen={menu?.paneId === item.id}
      onOpenMenu={openPaneMenu}
      onSubmit={(text, attachments) => sendToPane(item.id, text, attachments)}
      onStop={() => stopPane(item.id)}
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
              onFocus={focusPane}
              onToggle={toggle}
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

      {menu === null ? null : (
        <Menu label={`${menu.paneId} の操作`} placement={menu} onClose={closeMenu}>
          <p class="hwc-menu-head">{menu.paneId}</p>
          <button
            type="button"
            role="menuitem"
            class="hwc-menu-item"
            disabled={menuFull}
            onClick={openCreateDialog}
          >
            <PlusIcon size={14} />
            新しいペイン
          </button>
          {menuFull ? <p class="hwc-menu-note">このタブは 4 ペインまで</p> : null}
          {menuCommandsShown ? (
            <>
              <button
                type="button"
                role="menuitem"
                class="hwc-menu-item"
                disabled={!canRunNew}
                onClick={() => runPaneCommand("new")}
              >
                <NewSessionIcon size={14} />
                {commandLabel("new")}
              </button>
              <button
                type="button"
                role="menuitem"
                class="hwc-menu-item"
                disabled={!canRunCompact}
                onClick={() => runPaneCommand("compact")}
              >
                <CollapseIcon size={14} />
                {commandLabel("compact")}
              </button>
              {compactBlockedByHistory ? (
                <p class="hwc-menu-note">会話が小さいうちは圧縮できません</p>
              ) : null}
            </>
          ) : null}
          <hr class="hwc-menu-separator" />
          <button
            type="button"
            role="menuitem"
            class="hwc-menu-item hwc-menu-item--danger"
            onClick={openCloseConfirm}
          >
            <CloseIcon size={14} />
            ペインを閉じる
          </button>
        </Menu>
      )}

      {closing === null || closingPane === null ? null : (
        <CloseConfirm
          pane={closingPane}
          busy={closing.phase === "busy"}
          failed={closing.phase === "failed"}
          onConfirm={confirmClose}
          onCancel={cancelClose}
        />
      )}

      {createTarget === null ? null : (
        <CreatePane
          paneId={createTarget}
          onCreated={setPendingSelect}
          onClose={() => setCreateTarget(null)}
        />
      )}
    </div>
  );
}
