import type { ConnectionStatus } from "../connection";
import {
  BellIcon,
  ChevronRightIcon,
  CommitIcon,
  LinkIcon,
  ReloadIcon,
  TemplateIcon,
  ThemeIcon,
} from "../icons";
import type { ThemePreference } from "../theme";
import {
  SETTINGS_CATEGORIES,
  settingsCategoryValue,
  type SettingsCategory,
  type SettingsCategoryId,
  type SettingsCategoryValues,
} from "./categories";
import { useSettingsSummary } from "./use-summary";

type SettingsIndexProps = {
  theme: ThemePreference;
  connection: ConnectionStatus;
  revision: string | null;
  current: SettingsCategoryId | null;
  variant: "page" | "side";
  refreshKey: number;
  onOpen: (id: SettingsCategoryId) => void;
};

function CategoryIcon(props: { id: SettingsCategoryId }) {
  switch (props.id) {
    case "display":
      return <ThemeIcon size={20} />;
    case "templates":
      return <TemplateIcon size={20} />;
    case "notifications":
      return <BellIcon size={20} />;
    case "restart":
      return <ReloadIcon size={20} />;
    case "connection":
      return <LinkIcon size={20} />;
    case "build":
      return <CommitIcon size={20} />;
  }
}

function CategoryRow(props: {
  category: SettingsCategory;
  value: string | null;
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      class="hwc-settings-nav"
      aria-current={props.current ? "true" : undefined}
      onClick={props.onOpen}
    >
      <span class="hwc-settings-nav-icon">
        <CategoryIcon id={props.category.id} />
      </span>
      <span class="hwc-settings-nav-label">{props.category.label}</span>
      {props.value === null ? null : <span class="hwc-settings-nav-value">{props.value}</span>}
      <ChevronRightIcon size={16} />
    </button>
  );
}

// 設定の入口。行に現在値を出し、開かなくても状態が分かるようにする。
export function SettingsIndex(props: SettingsIndexProps) {
  const summary = useSettingsSummary(props.refreshKey);
  const values: SettingsCategoryValues = {
    theme: props.theme,
    connection: props.connection,
    revision: props.revision,
    templates: summary.templates,
    notifications: summary.notifications,
    restart: summary.restart,
  };

  const rows = (group: SettingsCategory["group"]) =>
    SETTINGS_CATEGORIES.filter((category) => category.group === group).map((category) => (
      <CategoryRow
        key={category.id}
        category={category}
        value={settingsCategoryValue(category.id, values)}
        current={props.current === category.id}
        onOpen={() => props.onOpen(category.id)}
      />
    ));

  if (props.variant === "side") {
    return (
      <nav class="hwc-settings-side" aria-label="設定のカテゴリ">
        <p class="hwc-settings-side-title">設定</p>
        {rows("settings")}
        <p class="hwc-settings-group-label">アプリ</p>
        {rows("app")}
      </nav>
    );
  }

  return (
    <div class="hwc-settings">
      <section>
        <div class="hwc-setting-group">{rows("settings")}</div>
      </section>
      <section>
        <p class="hwc-settings-group-label">アプリ</p>
        <div class="hwc-setting-group">{rows("app")}</div>
      </section>
    </div>
  );
}
