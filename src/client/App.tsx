import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState, PaneState } from "../server/herdr/state";
import { PaneDetail } from "./PaneDetail";
import { TabBar } from "./TabBar";
import { PaneList } from "./PaneList";
import { Settings } from "./Settings";
import { fetchState, parseAppState, sendInput } from "./api";
import {
  INITIAL_CONNECTION,
  connectionAfter,
  connectionLabel,
  type ConnectionStatus,
} from "./connection";
import { CloseIcon, HerdrMark, SettingsIcon } from "./icons";
import { HIDDEN_STORAGE_KEY, parseHiddenPanes, toggleHiddenPanes } from "./hidden";
import { findPane, findPaneContext, initialExpanded, splitPanes } from "./select";
import { gateSnapshot, type SnapshotOrigin } from "./snapshot";
import { trackWorking, workingMs } from "./time";
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

// 壁時計との同期。1 秒ごとに数え直し、稼働に入った時刻は手元で覚える。
function useWorkingClock(state: AppState | null) {
  const [now, setNow] = useState(() => Date.now());
  // 覚えた時刻は描画のたびに引き継ぐ。同じ入力なら同じ結果になるので、描画中に進めてよい。
  const workingSince = useRef<ReadonlyMap<string, number>>(new Map());
  if (state !== null) workingSince.current = trackWorking(workingSince.current, state, now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return { workingSince: workingSince.current, now };
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

// 最初に届いたスナップショットでは、Herdr が focus しているペインを開く。
function defaultSelection(state: AppState): string | null {
  return findPane(state, state.focusedPaneId) ? state.focusedPaneId : null;
}

type View = { selectedPaneId: string | null; expanded: ReadonlySet<string> };

// 開き方の初期値は最初のスナップショットで決めて、以後の focus 移動には追従しない。
// 読んでいる途中で勝手に別のペインへ切り替わらないようにするため。
function defaultView(state: AppState): View {
  return { selectedPaneId: defaultSelection(state), expanded: initialExpanded(state) };
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>(INITIAL_CONNECTION);
  // 利用者が選んだ・開いた結果だけを持つ。まだ触っていない間はスナップショットから導く。
  const [view, setView] = useState<View | null>(null);
  const initialView = useRef<View | null>(null);
  // 入力欄の補足は、送ったペインにだけ出す。分割表示で隣の欄に漏れないように。
  const [feedback, setFeedback] = useState<Record<string, string | null>>({});
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

  const { workingSince, now } = useWorkingClock(state);

  // 選んだペインがスナップショットから消えても id は残す。findPane が null を返すので
  // 表示は一覧に戻り、戻ってきたときは同じペインを開ける。
  const selectedPaneId = view
    ? view.selectedPaneId
    : state
      ? (initialView.current ??= defaultView(state)).selectedPaneId
      : null;
  const expanded = view
    ? view.expanded
    : state
      ? (initialView.current ??= defaultView(state)).expanded
      : NO_GROUPS;

  const pane = state ? findPane(state, selectedPaneId) : null;
  const context = state ? findPaneContext(state, selectedPaneId) : null;

  const select = (paneId: string) => {
    setView({ selectedPaneId: paneId, expanded });
    setFeedback((current) => ({ ...current, [paneId]: null }));
    setSettingsOpen(false);
  };

  const back = () => {
    setView({ selectedPaneId: null, expanded });
  };

  const toggle = (groupId: string) => {
    const next = new Set(expanded);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setView({ selectedPaneId, expanded: next });
  };

  // 送れたかどうかを返す。失敗したら入力欄が下書きを残せるようにする。
  const sendToPane = async (paneId: string, text: string): Promise<boolean> => {
    // 前の結果は消す。送り直したのに「送信しました」が残っていると、どれの結果か読めない。
    setFeedback((current) => ({ ...current, [paneId]: null }));
    try {
      await sendInput(paneId, text);
      setFeedback((current) => ({ ...current, [paneId]: "送信しました" }));
      return true;
    } catch {
      setFeedback((current) => ({ ...current, [paneId]: "送信できませんでした" }));
      return false;
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
  const splitOn = wide && split && shown.length > 1;

  const renderPane = (item: PaneState, where: { workspaceLabel: string; tabLabel: string }) => (
    <PaneDetail
      key={item.id}
      pane={item}
      context={where}
      feedback={feedback[item.id] ?? null}
      waitingMs={item.agentStatus === "working" ? workingMs(workingSince, item.id, now) : null}
      onSubmit={(text) => sendToPane(item.id, text)}
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
              expanded={expanded}
              onSelect={select}
              onToggle={toggle}
              workingSince={workingSince}
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
              {splitOn ? (
                <div class="hwc-split" data-count={shown.length}>
                  {shown.map((item) => (
                    <section class="hwc-split-cell" key={item.id}>
                      {renderPane(item, context)}
                    </section>
                  ))}
                </div>
              ) : (
                renderPane(pane, context)
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
