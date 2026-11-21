import type { ConnectionStatus } from "../connection";
import type { ModelLabels } from "../../shared/agents";
import {
  AgentGlyphIcon,
  BellIcon,
  ChevronRightIcon,
  CommitIcon,
  LinkIcon,
  SplitIcon,
  ReloadIcon,
  TemplateIcon,
  ThemeIcon,
} from "../icons";
import type { ThemePreference } from "../theme";
import {
  agentOfCategory,
  SETTINGS_CATEGORIES,
  SETTINGS_GROUP_LABELS,
  settingsCategoryBadge,
  settingsCategoryValue,
  type SettingsCategory,
  type SettingsCategoryId,
  type SettingsCategoryValues,
} from "./categories";
import { useSettingsSummary } from "./use-summary";

type SettingsIndexProps = {
  theme: ThemePreference;
  split: boolean;
  connection: ConnectionStatus;
  revision: string | null;
  current: SettingsCategoryId | null;
  variant: "page" | "side";
  labels: ModelLabels | null;
  refreshKey: number;
  onOpen: (id: SettingsCategoryId) => void;
};

function CategoryIcon(props: { id: SettingsCategoryId }) {
  switch (props.id) {
    case "display":
      return <ThemeIcon size={20} />;
    case "split":
      return <SplitIcon size={20} />;
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
    default:
      return <AgentGlyphIcon agent={agentOfCategory(props.id)} size={20} />;
  }
}

function CategoryRow(props: {
  category: SettingsCategory;
  value: string | null;
  badge: string | null;
  status: string | null;
  current: boolean;
  onOpen: () => void;
}) {
  const agent = agentOfCategory(props.category.id);

  return (
    <button
      type="button"
      class="hwc-settings-nav"
      aria-current={props.current ? "true" : undefined}
      onClick={props.onOpen}
    >
      <span class="hwc-settings-nav-icon" data-agent={agent ?? undefined}>
        <CategoryIcon id={props.category.id} />
      </span>
      <span class="hwc-settings-nav-label">{props.category.label}</span>
      {props.value === null ? null : (
        <span class="hwc-settings-nav-end">
          <span class="hwc-settings-nav-value" data-status={props.status ?? undefined}>
            {props.value}
          </span>
          {props.badge === null ? null : <span class="hwc-effort-badge">{props.badge}</span>}
        </span>
      )}
      <ChevronRightIcon size={16} />
    </button>
  );
}

// 設定の入口。行に現在値を出し、開かなくても状態が分かるようにする。
export function SettingsIndex(props: SettingsIndexProps) {
  const summary = useSettingsSummary(props.refreshKey);
  const values: SettingsCategoryValues = {
    theme: props.theme,
    split: props.split,
    connection: props.connection,
    revision: props.revision,
    templates: summary.templates,
    notifications: summary.notifications,
    restart: summary.restart,
    launchDefaults: summary.launchDefaults,
    modelLabels: props.labels,
  };

  const rows = (group: SettingsCategory["group"]) =>
    SETTINGS_CATEGORIES.filter((category) => category.group === group).map((category) => (
      <CategoryRow
        key={category.id}
        category={category}
        value={settingsCategoryValue(category.id, values)}
        badge={settingsCategoryBadge(category.id, values)}
        status={props.variant === "page" && category.id === "connection" ? props.connection : null}
        current={props.current === category.id}
        onOpen={() => props.onOpen(category.id)}
      />
    ));

  // 見出しは上部バーが持つ。左の列は行だけで始め、グループの切れ目だけをラベルで示す。
  if (props.variant === "side") {
    return (
      <nav class="hwc-settings-side" aria-label="設定のカテゴリ">
        {rows("settings")}
        <p class="hwc-settings-group-label">{SETTINGS_GROUP_LABELS.agents}</p>
        {rows("agents")}
        <p class="hwc-settings-group-label">{SETTINGS_GROUP_LABELS.app}</p>
        {rows("app")}
      </nav>
    );
  }

  return (
    <div class="hwc-settings hwc-settings-index">
      <section>
        <div class="hwc-setting-group">{rows("settings")}</div>
      </section>
      <section>
        <p class="hwc-settings-group-label">{SETTINGS_GROUP_LABELS.agents}</p>
        <div class="hwc-setting-group">{rows("agents")}</div>
      </section>
      <section>
        <p class="hwc-settings-group-label">{SETTINGS_GROUP_LABELS.app}</p>
        <div class="hwc-setting-group">{rows("app")}</div>
      </section>
    </div>
  );
}
