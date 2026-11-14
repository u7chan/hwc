import { useState } from "preact/hooks";
import { useElementWidth } from "../app/use-element-width";
import type { ConnectionStatus } from "../connection";
import { ChevronLeftIcon } from "../icons";
import { SETTINGS_SIDE_MIN_WIDTH } from "../layout";
import type { ThemePreference } from "../theme";
import { BuildSettings } from "./BuildSettings";
import { ConnectionSettings } from "./ConnectionSettings";
import { DisplaySettings } from "./DisplaySettings";
import { NotificationSettings } from "./NotificationSettings";
import { RestartSettings } from "./RestartSettings";
import { SettingsIndex } from "./SettingsIndex";
import { settingsCategoryLabel, type SettingsCategoryId } from "./categories";
import { TemplateSettings } from "./TemplateSettings";

type SettingsProps = {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  revision: string | null;
  connection: ConnectionStatus;
  wide: boolean;
  onClose: () => void;
};

function section(
  id: SettingsCategoryId,
  props: SettingsProps,
  callbacks: { onEditingTitleChange: (title: string | null) => void; onSaved: () => void },
) {
  switch (id) {
    case "display":
      return <DisplaySettings theme={props.theme} onThemeChange={props.onThemeChange} />;
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
  }
}

export function Settings(props: SettingsProps) {
  const [opened, setOpened] = useState<SettingsCategoryId | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  // 保存で一覧の現在値が変わる。詳細を開いたままでも引き直せるよう、番号を進める。
  const [summaryKey, setSummaryKey] = useState(0);
  const refreshSummary = () => setSummaryKey((key) => key + 1);

  // 選び直したときは中身を作り直す。セクションが持つ編集中の状態と、バーに出す名前を
  // 同じ操作で初期化するため（写しが残ると「定型文」と編集フォームが食い違う）。
  const [visit, setVisit] = useState(0);

  // カテゴリを左に常設できるかは、詳細に実際に残っている幅で決める。ペイン一覧の
  // 幅は変えられるので、ウィンドウ幅だけでは足りない。
  const { ref: frameRef, width: frameWidth } = useElementWidth<HTMLDivElement>();
  const sideBySide = props.wide && frameWidth !== null && frameWidth >= SETTINGS_SIDE_MIN_WIDTH;

  // 狭い画面は一覧から始め、開いたカテゴリだけを出す。広い画面はカテゴリを左に
  // 常設するので、何も開いていなければ先頭を出す。
  const shown = opened ?? "display";

  // 選んでいるカテゴリをもう一度押しても何もしない。作り直すと、入力途中のフォームが
  // 確認なしに消える。
  const open = (id: SettingsCategoryId) => {
    if (id === opened) return;
    setEditingTitle(null);
    setVisit((count) => count + 1);
    setOpened(id);
    // カテゴリを移るついでに一覧の値も読み直す。前回の読み込みが失敗していても、
    // 保存するまで空のままにならない。
    refreshSummary();
  };
  const back = () => {
    setEditingTitle(null);
    if (opened === null) props.onClose();
    else setOpened(null);
  };

  const index = (variant: "page" | "side", active: SettingsCategoryId | null) => (
    <SettingsIndex
      theme={props.theme}
      connection={props.connection}
      revision={props.revision}
      current={active}
      variant={variant}
      refreshKey={summaryKey}
      onOpen={open}
    />
  );

  // 幅をまたいでも中身を組み替えない。組み替えると、入力途中のフォームが作り直されて
  // 下書きが消える。広い画面の要素は hidden で隠すだけにする。
  return (
    <div class="hwc-detail-inner">
      <header class="hwc-detail-bar" hidden={sideBySide}>
        {/* 狭い画面では一覧ごと隠れるので、設定を閉じる道をここに残す。 */}
        <button
          type="button"
          class="hwc-icon-button"
          aria-label={opened === null ? "設定を閉じる" : "設定の一覧へ戻る"}
          onClick={back}
        >
          <ChevronLeftIcon />
        </button>
        <h2 class="hwc-detail-title">
          {opened === null ? "設定" : (editingTitle ?? settingsCategoryLabel(opened))}
        </h2>
      </header>

      <div class="hwc-settings-wide" data-side={sideBySide} ref={frameRef}>
        <div class="hwc-settings-side" hidden={!sideBySide}>
          {sideBySide ? index("side", shown) : null}
        </div>

        <div class="hwc-settings-scroll">
          {/* カテゴリを左に常設している間はバーを隠すので、見出しは本文の側に置く。 */}
          {sideBySide ? (
            <h2 class="hwc-visually-hidden">{editingTitle ?? settingsCategoryLabel(shown)}</h2>
          ) : null}
          {opened === null && !sideBySide ? (
            index("page", null)
          ) : (
            <div class="hwc-settings" key={visit}>
              {section(shown, props, {
                onEditingTitleChange: setEditingTitle,
                onSaved: refreshSummary,
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
