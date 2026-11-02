import { connectionLabel, type ConnectionStatus } from "./connection";
import { ThemePicker } from "./ThemePicker";
import type { ThemePreference } from "./theme";

type SettingsProps = {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  revision: string | null;
  connection: ConnectionStatus;
};

export function Settings(props: SettingsProps) {
  return (
    <div class="hwc-detail-inner">
      <header class="hwc-detail-bar">
        <h2 class="hwc-detail-title">設定</h2>
      </header>

      <div class="hwc-settings-scroll">
        <div class="hwc-settings">
          <section class="hwc-section">
            <h3 class="hwc-section-title">表示</h3>
            <ThemePicker value={props.theme} onChange={props.onThemeChange} />
            <p class="hwc-section-note">システムは端末の外観設定に合わせます。</p>
          </section>

          <section class="hwc-section">
            <h3 class="hwc-section-title">接続</h3>
            <div class="hwc-setting-group">
              <div class="hwc-setting-row">
                <span class="hwc-setting-label">状態</span>
                <span class="hwc-setting-value" data-status={props.connection}>
                  {connectionLabel(props.connection)}
                </span>
              </div>
            </div>
            <p class="hwc-section-note">
              Herdr から届いた状態をそのまま表示しています。切断するとブラウザが自動で再接続します。
            </p>
          </section>

          <section class="hwc-section">
            <h3 class="hwc-section-title">このビルド</h3>
            <div class="hwc-setting-group">
              <div class="hwc-setting-row">
                <span class="hwc-setting-label">コミット</span>
                <span class="hwc-setting-value">{props.revision ?? "取得できませんでした"}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
