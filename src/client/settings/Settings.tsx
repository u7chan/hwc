import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useElementWidth } from "../app/use-element-width";
import type { ConnectionStatus } from "../connection";
import type { FileTreeIcons, FileTreeSize, FileTreeWidth } from "../file-tree-display";
import type { FileTreeSide } from "../file-tree-side";
import type { ModelLabels } from "../../shared/agents";
import { useModelLabels } from "../launch-candidates";
import { ChevronLeftIcon, CloseIcon } from "../icons";
import type { LiveUpdateInterval } from "../live-update";
import { SETTINGS_SIDE_MIN_WIDTH } from "../layout";
import type { SplitPrefs } from "../split-prefs";
import type { ThemePreference } from "../theme";
import { BuildSettings } from "./BuildSettings";
import { ConnectionSettings } from "./ConnectionSettings";
import { DisplaySettings } from "./DisplaySettings";
import { LiveUpdateSettings } from "./LiveUpdateSettings";
import { NotificationSettings } from "./NotificationSettings";
import { RestartSettings } from "./RestartSettings";
import { SettingsIndex } from "./SettingsIndex";
import { SplitSettings } from "./SplitSettings";
import { agentOfCategory, settingsCategoryLabel, type SettingsCategoryId } from "./categories";
import { AgentSettings } from "./AgentSettings";
import { AgentSkills } from "./AgentSkills";
import { TemplateSettings } from "./TemplateSettings";

type SettingsProps = {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  splitPrefs: SplitPrefs;
  onSplitPrefsChange: (prefs: SplitPrefs) => void;
  liveUpdate: LiveUpdateInterval;
  onLiveUpdateChange: (interval: LiveUpdateInterval) => void;
  treeSide: FileTreeSide;
  onTreeSideChange: (side: FileTreeSide) => void;
  treeSize: FileTreeSize;
  onTreeSizeChange: (size: FileTreeSize) => void;
  treeWidth: FileTreeWidth;
  onTreeWidthChange: (width: FileTreeWidth) => void;
  treeIcons: FileTreeIcons;
  onTreeIconsChange: (icons: FileTreeIcons) => void;
  revision: string | null;
  connection: ConnectionStatus;
  wide: boolean;
  onClose: () => void;
};

function section(
  id: SettingsCategoryId,
  props: SettingsProps,
  callbacks: { onEditingTitleChange: (title: string | null) => void; onSaved: () => void },
  labels: ModelLabels | null,
) {
  switch (id) {
    case "display":
      return (
        <DisplaySettings
          theme={props.theme}
          onThemeChange={props.onThemeChange}
          treeSide={props.treeSide}
          onTreeSideChange={props.onTreeSideChange}
          treeSize={props.treeSize}
          onTreeSizeChange={props.onTreeSizeChange}
          treeWidth={props.treeWidth}
          onTreeWidthChange={props.onTreeWidthChange}
          treeIcons={props.treeIcons}
          onTreeIconsChange={props.onTreeIconsChange}
        />
      );
    case "split":
      return <SplitSettings prefs={props.splitPrefs} onChange={props.onSplitPrefsChange} />;
    case "live":
      return <LiveUpdateSettings value={props.liveUpdate} onChange={props.onLiveUpdateChange} />;
    case "templates":
      return (
        <TemplateSettings
          onEditingTitleChange={callbacks.onEditingTitleChange}
          onSaved={callbacks.onSaved}
        />
      );
    case "notifications":
      return <NotificationSettings onSaved={callbacks.onSaved} />;
    case "restart":
      return <RestartSettings onSaved={callbacks.onSaved} />;
    case "connection":
      return <ConnectionSettings connection={props.connection} />;
    case "build":
      return <BuildSettings revision={props.revision} />;
    default: {
      const agent = agentOfCategory(id);
      return agent === null ? null : (
        <>
          <AgentSettings agent={agent} labels={labels} onSaved={callbacks.onSaved} />
          {/* エージェントを移ったら、開いていた一覧も閉じた状態に戻す。 */}
          <AgentSkills key={agent} agent={agent} />
        </>
      );
    }
  }
}

export function Settings(props: SettingsProps) {
  const [opened, setOpened] = useState<SettingsCategoryId | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  // 保存で一覧の現在値が変わる。詳細を開いたままでも引き直せるよう、番号を進める。
  const [summaryKey, setSummaryKey] = useState(0);
  const refreshSummary = () => setSummaryKey((key) => key + 1);
  const labels = useModelLabels(true);

  // カテゴリを左に常設できるかは、詳細に実際に残っている幅で決める。ペイン一覧の
  // 幅は変えられるので、ウィンドウ幅だけでは足りない。
  const { ref: frameRef, width: frameWidth } = useElementWidth<HTMLDivElement>();
  const sideBySide = props.wide && frameWidth !== null && frameWidth >= SETTINGS_SIDE_MIN_WIDTH;

  // 狭い画面は一覧から始め、開いたカテゴリだけを出す。広い画面はカテゴリを左に
  // 常設するので、何も開いていなければ先頭を出す。
  const shown = opened ?? "display";

  // いま出しているカテゴリ。広い画面は何も開いていなくても先頭を出している。
  const active = sideBySide ? shown : opened;

  // カテゴリを常設している間の見出しは、画面の名前である「設定」にする。どのカテゴリを
  // 出しているかは左の列が示す。定型文のフォームだけは、開いている段の名前を出す。
  const title =
    editingTitle ?? (opened === null || sideBySide ? "設定" : settingsCategoryLabel(opened));

  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = scrollRef.current;
    if (target !== null) target.scrollTop = 0;
  }, [active]);

  // 設定を 1 つの面として扱う。開いたら面へ焦点を移し、閉じたら元の場所へ返す。
  const surfaceRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surface?.focus({ preventScroll: true });
    return () => {
      // 一覧の行を押して閉じたときは、その行の焦点を奪わない。
      if (!surface?.contains(document.activeElement) && document.activeElement !== document.body) {
        return;
      }
      // 狭い画面は、閉じた直後に一覧が戻る。隠れている間は焦点を当てられないので、
      // 表示が切り替わってから返す。
      queueMicrotask(() => {
        if (restoreRef.current?.isConnected === true) {
          restoreRef.current.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  // 出しているカテゴリをもう一度押しても何もしない。作り直すと、入力途中のフォームが
  // 確認なしに消える。移るときは、編集中の名前も同じ操作で初期化する。
  const open = (id: SettingsCategoryId) => {
    if (id === active) return;
    setEditingTitle(null);
    setOpened(id);
    // カテゴリを移るついでに一覧の値も読み直す。前回の読み込みが失敗していても、
    // 保存するまで空のままにならない。
    refreshSummary();
  };
  // 広い画面はカテゴリの一覧が常に見えているので、戻る先は元の画面だけ。
  const leaving = sideBySide || opened === null;
  const back = () => {
    setEditingTitle(null);
    if (leaving) props.onClose();
    else setOpened(null);
  };
  // 購読を貼り直さずに、常に最新の back を呼ぶ。
  const backRef = useRef(back);
  backRef.current = back;

  // Esc は、設定を見ている間だけ上部バーのボタンと同じ動きにする。焦点が一覧のメニューやダイアログへ
  // 移っている間は、そちらが Esc を取る。狭い画面はカテゴリを開いた時点で押した行が
  // 消えるので、焦点の無い body もこの面のものとして扱う。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"], [role="alertdialog"]') !== null
      ) {
        return;
      }
      const focused = document.activeElement;
      if (focused !== document.body && surfaceRef.current?.contains(focused) !== true) return;
      event.preventDefault();
      backRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const index = (variant: "page" | "side", active: SettingsCategoryId | null) => (
    <SettingsIndex
      theme={props.theme}
      split={props.splitPrefs.autoSplit}
      liveUpdate={props.liveUpdate}
      connection={props.connection}
      revision={props.revision}
      current={active}
      variant={variant}
      labels={labels}
      refreshKey={summaryKey}
      onOpen={open}
    />
  );

  // 幅をまたいでも中身を組み替えない。組み替えると、入力途中のフォームが作り直されて
  // 下書きが消える。上部バーの名前だけを差し替える。
  return (
    <div class="hwc-detail-inner" ref={surfaceRef} tabIndex={-1}>
      <header class="hwc-detail-bar hwc-settings-bar">
        {/* 狭い画面では一覧ごと隠れる。広い画面では足元の歯車が遠い。どちらも、
            設定の左上から元の画面へ戻れるようにする。設定を出る操作は ×、設定の中で一つ戻る
            操作だけ <。広い画面の一覧の開閉（<）と見分けが付くようにする。 */}
        <button
          type="button"
          class="hwc-icon-button"
          aria-label={leaving ? "設定を閉じる" : "設定の一覧へ戻る"}
          onClick={back}
        >
          {leaving ? <CloseIcon /> : <ChevronLeftIcon />}
        </button>
        <h2 class="hwc-detail-title hwc-settings-title" key={title}>
          {title}
        </h2>
      </header>

      <div class="hwc-settings-wide" data-side={sideBySide} ref={frameRef}>
        {sideBySide ? index("side", shown) : null}

        <div class="hwc-settings-scroll" ref={scrollRef}>
          {/* 上部バーの名前は画面のもの。本文の側には、出しているカテゴリの名前を置く。
              定型文のフォームを開いても、ここは「定型文」のままにする。 */}
          {sideBySide ? <h2 class="hwc-visually-hidden">{settingsCategoryLabel(shown)}</h2> : null}
          {opened === null && !sideBySide ? (
            index("page", null)
          ) : (
            <div class="hwc-settings hwc-settings-detail" key={shown}>
              {section(
                shown,
                props,
                {
                  onEditingTitleChange: setEditingTitle,
                  onSaved: refreshSummary,
                },
                labels,
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
