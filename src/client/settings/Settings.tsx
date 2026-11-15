import type { ConnectionStatus } from "../connection";
import { ChevronLeftIcon } from "../icons";
import type { ThemePreference } from "../theme";
import { BuildSettings } from "./BuildSettings";
import { ConnectionSettings } from "./ConnectionSettings";
import { DisplaySettings } from "./DisplaySettings";
import { NotificationSettings } from "./NotificationSettings";
import { RestartSettings } from "./RestartSettings";
import { TemplateSettings } from "./TemplateSettings";

type SettingsProps = {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  revision: string | null;
  connection: ConnectionStatus;
  onClose: () => void;
};

export function Settings(props: SettingsProps) {
  return (
    <div class="hwc-detail-inner">
      <header class="hwc-detail-bar">
        {/* 狭い画面では一覧ごと隠れるので、設定を閉じる道をここに残す。 */}
        <button
          type="button"
          class="hwc-icon-button hwc-back"
          aria-label="戻る"
          onClick={props.onClose}
        >
          <ChevronLeftIcon />
        </button>
        <h2 class="hwc-detail-title">設定</h2>
      </header>

      <div class="hwc-settings-scroll">
        <div class="hwc-settings">
          <DisplaySettings theme={props.theme} onThemeChange={props.onThemeChange} />
          <TemplateSettings />
          <NotificationSettings />
          <RestartSettings />
          <ConnectionSettings connection={props.connection} />
          <BuildSettings revision={props.revision} />
        </div>
      </div>
    </div>
  );
}
