import { connectionLabel, type ConnectionStatus } from "../connection";
import { themeLabel, type ThemePreference } from "../theme";

export type SettingsCategoryId =
  | "display"
  | "templates"
  | "notifications"
  | "restart"
  | "connection"
  | "build";

export type SettingsCategory = {
  id: SettingsCategoryId;
  label: string;
  group: "settings" | "app";
};

// 操作する設定と、状態を見るだけの項目を分ける。並びは変える頻度の高い順。
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: "display", label: "表示", group: "settings" },
  { id: "templates", label: "定型文", group: "settings" },
  { id: "notifications", label: "通知", group: "settings" },
  { id: "restart", label: "再起動", group: "settings" },
  { id: "connection", label: "接続", group: "app" },
  { id: "build", label: "このビルド", group: "app" },
];

export function settingsCategoryLabel(id: SettingsCategoryId): string {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.label ?? "";
}

export type SettingsCategoryValues = {
  theme: ThemePreference;
  connection: ConnectionStatus;
  revision: string | null;
  templates: number | null;
  notifications: boolean | null;
  restart: boolean | null;
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
  }
}
