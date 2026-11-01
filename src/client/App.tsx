import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { PaneDetail } from "./PaneDetail";
import { PaneList } from "./PaneList";
import { Settings } from "./Settings";
import { previewOutput, previewState } from "./fixtures";
import { CloseIcon, HerdrMark, SettingsIcon } from "./icons";
import { findPane, findPaneContext, initialExpanded, movePane, removePane } from "./select";
import { trackWorking } from "./time";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_STEP,
  SIDEBAR_STORAGE_KEY,
  clampSidebarWidth,
  parseSidebarWidth,
} from "./layout";
import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  type ThemePreference,
} from "./theme";

export function App() {
  // プレビューでは閉じたペインを手元で落とす。実 API に繋いだらサーバーの状態で置き換わる。
  const [state, setState] = useState(previewState);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(state));
  const [feedback, setFeedback] = useState<string | null>(null);
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

  // どの版を見ているかを画面で確かめられるようにする。取れなくても表示だけ諦める。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => response.json())
      .then((data: { revision?: unknown }) => {
        if (!cancelled && typeof data.revision === "string") setRevision(data.revision);
      })
      .catch(() => {
        // 取れないときはラベルを出さない。
      });
    return () => {
      cancelled = true;
    };
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

  // 稼働に入った時刻は手元で覚える。1 秒ごとに数え直して経過として出す。
  const [workingSince, setWorkingSince] = useState<ReadonlyMap<string, number>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setWorkingSince((current) => trackWorking(current, state, Date.now()));
  }, [state]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 行に落としたら、その行の前後に入れる。タブへ落としたら末尾に足す。
  const dropOnPane = (paneId: string, targetPaneId: string, after: boolean) => {
    setState((current) => {
      for (const workspace of current.workspaces) {
        for (const tab of workspace.tabs) {
          const index = tab.panes.findIndex((item) => item.id === targetPaneId);
          if (index === -1) continue;
          return movePane(current, paneId, tab.id, index + (after ? 1 : 0));
        }
      }
      return current;
    });
  };

  const closePane = (paneId: string) => {
    setState((current) => removePane(current, paneId));
    if (selectedPaneId === paneId) setSelectedPaneId(null);
    setFeedback(`ペイン ${paneId} を閉じました`);
  };

  const pane = findPane(state, selectedPaneId);
  const context = findPaneContext(state, selectedPaneId);

  const toggle = (groupId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const select = (paneId: string) => {
    setSelectedPaneId(paneId);
    setFeedback(null);
    setSettingsOpen(false);
  };

  // 配線前のプレビュー。実 API では取得中を null で表し、skeleton を出す。
  const [output, setOutput] = useState<string | null>(null);
  useEffect(() => {
    if (!pane) return;
    setOutput(null);
    const timer = setTimeout(() => setOutput(previewOutput(pane.id)), 450);
    return () => clearTimeout(timer);
  }, [pane?.id]);

  // タブは選択中ペインのワークスペースにあるペイン全部。
  const siblings = useMemo(() => {
    if (!pane) return [];
    const workspace = state.workspaces.find((item) =>
      item.tabs.some((tab) => tab.panes.some((candidate) => candidate.id === pane.id)),
    );
    return workspace ? workspace.tabs.flatMap((tab) => tab.panes) : [];
    // 並べ替えで状態そのものが変わる。
  }, [pane?.id, state]);

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
        <div class="hwc-top-actions">
          <span class="hwc-conn">
            <span class="hwc-conn-dot" />
            プレビュー
          </span>
          <button
            type="button"
            class="hwc-icon-button hwc-top-button"
            aria-label={settingsOpen ? "設定を閉じる" : "設定"}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            {settingsOpen ? <CloseIcon /> : <SettingsIcon />}
          </button>
        </div>
      </header>

      <div class="hwc-body">
        <aside class="hwc-list" aria-label="ペイン一覧">
          <PaneList
            state={state}
            selectedPaneId={selectedPaneId}
            expanded={expanded}
            onSelect={select}
            onToggle={toggle}
            onClosePane={closePane}
            onDropPane={dropOnPane}
            workingSince={workingSince}
            now={now}
          />
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
              clampSidebarWidth(drag.current.startWidth + event.clientX - drag.current.startX),
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
            />
          ) : pane && context ? (
            <PaneDetail
              key={pane.id}
              pane={pane}
              context={context}
              panes={siblings}
              onSelectPane={select}
              output={output}
              onBack={() => setSelectedPaneId(null)}
              onSubmit={async () => {
                // 配線前でも送信中の見た目を確かめられるように、往復ぶんだけ待つ。
                await new Promise((resolve) => setTimeout(resolve, 600));
                setFeedback("プレビュー：送信はまだ繋がっていません");
              }}
              onDropPane={dropOnPane}
              feedback={feedback}
            />
          ) : (
            <div class="hwc-empty hwc-empty--detail">
              <div class="hwc-empty-mark">
                <span class="hwc-empty-glyph">›_</span>
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
