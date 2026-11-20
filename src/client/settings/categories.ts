import {
  AGENT_KINDS,
  AGENT_LABELS,
  type ModelAgentKind,
  type ModelLabels,
  modelLabel,
  supportsModelSelection,
} from "../../shared/agents";
import type { LaunchDefaults } from "../../shared/launch-defaults";
import { connectionLabel, type ConnectionStatus } from "../connection";
import { themeLabel, type ThemePreference } from "../theme";

// エージェントごとの画面。いまは新しいペインの既定モデルと effort だけを持つ（ADR 0104）。
export type AgentCategoryId = `agent-${ModelAgentKind}`;

export type SettingsCategoryId =
  | "display"
  | "split"
  | "templates"
  | "notifications"
  | "restart"
  | AgentCategoryId
  | "connection"
  | "build";

export type SettingsCategory = {
  id: SettingsCategoryId;
  label: string;
  group: "settings" | "agents" | "app";
};

export function agentOfCategory(id: SettingsCategoryId): ModelAgentKind | null {
  if (!id.startsWith("agent-")) return null;
  const agent = id.slice("agent-".length);
  return supportsModelSelection(agent) ? agent : null;
}

// 操作する設定と、状態を見るだけの項目を分ける。並びは変える頻度の高い順。エージェントは
// 作成ダイアログのカードと同じ順に並べる。
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: "display", label: "表示", group: "settings" },
  { id: "split", label: "ペイン分割", group: "settings" },
  { id: "templates", label: "定型文", group: "settings" },
  { id: "notifications", label: "通知", group: "settings" },
  { id: "restart", label: "再起動", group: "settings" },
  ...AGENT_KINDS.filter(supportsModelSelection).map((agent): SettingsCategory => ({
    id: `agent-${agent}`,
    label: AGENT_LABELS[agent],
    group: "agents",
  })),
  { id: "connection", label: "接続", group: "app" },
  { id: "build", label: "バージョン", group: "app" },
];

export const SETTINGS_GROUP_LABELS: Record<
  Exclude<SettingsCategory["group"], "settings">,
  string
> = {
  agents: "エージェント",
  app: "アプリ",
};

export function settingsCategoryLabel(id: SettingsCategoryId): string {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.label ?? "";
}

export type SettingsCategoryValues = {
  theme: ThemePreference;
  split: boolean | null;
  connection: ConnectionStatus;
  revision: string | null;
  templates: number | null;
  notifications: boolean | null;
  restart: boolean | null;
  launchDefaults: LaunchDefaults | null;
  modelLabels: ModelLabels | null;
};

// 一覧の行に出す現在値。読めていない値は null にして、行には何も出さない。
// 詳細を開かなくても「いまどうなっているか」だけが分かればよく、内容は繰り返さない。
export function settingsCategoryValue(
  id: SettingsCategoryId,
  values: SettingsCategoryValues,
): string | null {
  switch (id) {
    case "display":
      return themeLabel(values.theme);
    case "split":
      return values.split === null ? null : values.split ? "オン" : "オフ";
    case "templates":
      return values.templates === null ? null : `${values.templates} 件`;
    case "notifications":
      return values.notifications === null ? null : values.notifications ? "オン" : "オフ";
    case "restart":
      return values.restart === null ? null : values.restart ? "設定済み" : "未設定";
    case "connection":
      return connectionLabel(values.connection);
    case "build":
      return values.revision;
    default: {
      const agent = agentOfCategory(id);
      if (agent === null || values.launchDefaults === null) return null;
      const saved = values.launchDefaults[agent];
      return saved === undefined ? "未設定" : modelLabel(agent, saved.model, values.modelLabels);
    }
  }
}

// 現在値の右に札で添える値。エージェントの行の effort だけが持つ。
export function settingsCategoryBadge(
  id: SettingsCategoryId,
  values: SettingsCategoryValues,
): string | null {
  const agent = agentOfCategory(id);
  if (agent === null || values.launchDefaults === null) return null;
  return values.launchDefaults[agent]?.effort ?? null;
}
