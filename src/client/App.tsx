import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AppState, PaneState } from "../server/herdr/state";
import { PaneDetail } from "./PaneDetail";
import { TabBar } from "./TabBar";
import { PaneList } from "./PaneList";
import { Settings } from "./Settings";
import { fetchState, focusAgent, parseAppState, sendInput } from "./api";
import {
  INITIAL_CONNECTION,
  connectionAfter,
  connectionLabel,
  type ConnectionStatus,
} from "./connection";
import { CloseIcon, HerdrMark, SettingsIcon } from "./icons";
import { HIDDEN_STORAGE_KEY, parseHiddenPanes, toggleHiddenPanes } from "./hidden";
import {
  findPane,
  findPaneContext,
  findPaneRow,
  groupIds,
  initialExpanded,
  splitPanes,
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
  isCompactCell,
  isStackedCell,
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

// 分割セルの入力欄を畳むかは、セルの box の高さ・幅と、上下に積まれた段かで決める。PaneDetail は
// fragment を返すので自分では測れない。内容高を測ると畳んだ切替で再ループするため box を使う。
function SplitCell(props: { stacked: boolean; children: (compact: boolean) => ComponentChildren }) {
  const cell = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  // 積まれた段かは枚数で変わり、resize では変わらない。依存としてだけ読む。
  const { stacked } = props;

  useLayoutEffect(() => {
    const element = cell.current;
    if (!element) return;
    const measure = (height: number, width: number) =>
      setCompact(isCompactCell(height, width, stacked));
    // observe は変化しか届かない。枚数が変わった直後の値を effect で一度測る。
    measure(element.clientHeight, element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].borderBoxSize[0];
      measure(box?.blockSize ?? element.clientHeight, box?.inlineSize ?? element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [stacked]);

  return (
    <section class="hwc-split-cell" data-compact={compact} ref={cell}>
      {props.children(compact)}
    </section>
  );
}

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
    fetch("/api/health", { signal: controller.signal })
      .then((response) => response.json())
      .then((data: { revision?: unknown }) => {
        if (typeof data.revision === "string") setRevision(data.revision);
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

  const select = (paneId: string) => {
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
    setView({ selectedPaneId: null, expanded });
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

  const actions = (
    <>
      <span class="hwc-conn" data-status={connection}>
        <span class="hwc-conn-dot" />
        {connectionLabel(connection)}
      </span>
      <button
        type="button"
        class="hwc-icon-button hwc-top-button"
        aria-label={settingsOpen ? "設定を閉じる" : "設定"}
        onClick={() => setSettingsOpen((open) => !open)}
      >
        {settingsOpen ? <CloseIcon /> : <SettingsIcon />}
      </button>
    </>
  );

  // 分割は広い画面だけ。狭い画面では 1 枚ずつ見る。
  const shown = splitPanes(siblings, pane?.id ?? "", hidden);
  // 隠して 1 枚になってもグリッドを外さない。外すとペインの作り直しで
  // 読んでいた位置が最下部に戻る。
  const splitOn = wide && split && shown.length > 0;
  const cells = splitOn ? shown : pane === null ? [] : [pane];

  const renderPane = (
    item: PaneState,
    where: { workspaceLabel: string; tabLabel: string },
    compact: boolean,
  ) => (
    <PaneDetail
      key={item.id}
      pane={item}
      context={where}
      compact={compact}
      waitingMs={item.agentStatus === "working" ? workingMs(workingSince, item.id, now) : null}
      onSubmit={(text, attachments) => sendToPane(item.id, text, attachments)}
    />
  );

  const listPlaceholder = (
    <div class="hwc-empty">
      <div class="hwc-empty-mark">
        <HerdrMark size={32} />
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
        <HerdrMark size={40} />
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
      <header class="hwc-top">
        <div class="hwc-brand">
          <span class="hwc-mark">
            <HerdrMark size={28} />
          </span>
          <span class="hwc-brand-name">HWC</span>
        </div>
        {wide ? null : <div class="hwc-top-actions">{actions}</div>}
      </header>

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
          {wide ? <div class="hwc-sidebar-foot">{actions}</div> : null}
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
                onSelectPane={select}
                onToggleHidden={toggleHidden}
                onBack={back}
                onToggleSplit={toggleSplit}
              />
              {wide ? (
                <div class="hwc-split" data-count={cells.length}>
                  {cells.map((item, index) => (
                    <SplitCell key={item.id} stacked={isStackedCell(cells.length, index)}>
                      {(compact) => renderPane(item, context, compact)}
                    </SplitCell>
                  ))}
                </div>
              ) : (
                renderPane(pane, context, false)
              )}
            </div>
          ) : (
            <div class="hwc-empty hwc-empty--detail">
              <div class="hwc-empty-mark hwc-empty-mark--app">
                <HerdrMark size={40} />
              </div>
              <h2 class="hwc-empty-title">ペインを選んでください</h2>
              <p class="hwc-empty-text">一覧からペインを選ぶと、出力と入力欄が出ます。</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
