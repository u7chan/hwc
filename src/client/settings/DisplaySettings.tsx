import type { ThemePreference } from "../theme";
import { ThemePicker } from "./ThemePicker";

type DisplaySettingsProps = {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
};

export function DisplaySettings(props: DisplaySettingsProps) {
  return (
    <section>
      <ThemePicker value={props.theme} onChange={props.onThemeChange} />
      <p class="hwc-section-note">システムは端末の外観設定に合わせます。</p>
    </section>
  );
}
