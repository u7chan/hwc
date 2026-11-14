import { useState } from "preact/hooks";
import type { ConnectionStatus } from "../connection";
import { ChevronLeftIcon } from "../icons";
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

  // 狭い画面は一覧から始め、開いたカテゴリだけを出す。広い画面はカテゴリを左に
  // 常設するので、何も開いていなければ先頭を出す。
  const shown = opened ?? "display";

  // 画面を移るときは編集中の見出しを捨てる。詳細を離れるとフォームごと閉じるため。
  const open = (id: SettingsCategoryId) => {
    setEditingTitle(null);
    setOpened(id);
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

  // 幅をまたいでも中身を組み替えない。組み替えると、入力途中のフォームが
  // 作り直されて下書きが消える。広い画面の要素は hidden で隠すだけにする。
  return (
    <div class="hwc-detail-inner">
      <header class="hwc-detail-bar" hidden={props.wide}>
        {/* 狭い画面では一覧ごと隠れるので、設定を閉じる道をここに残す。 */}
        <button
          type="button"
          class="hwc-icon-button hwc-back"
          aria-label={opened === null ? "設定を閉じる" : "設定の一覧へ戻る"}
          onClick={back}
        >
          <ChevronLeftIcon />
        </button>
        <h2 class="hwc-detail-title">
          {opened === null ? "設定" : (editingTitle ?? settingsCategoryLabel(opened))}
        </h2>
      </header>

      <div class="hwc-settings-wide">
        <div class="hwc-settings-side" hidden={!props.wide}>
          {props.wide ? index("side", shown) : null}
        </div>

        <div class="hwc-settings-scroll">
          {opened === null && !props.wide ? (
            index("page", null)
          ) : (
            <div class="hwc-settings">
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
