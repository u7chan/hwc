import { ChoiceCard } from "./ChoiceCard";
import { themeGroups, type ThemeMeta, type ThemePreference } from "./theme";

type ThemePickerProps = {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
};

// 面の色を 1 枚ずつ見せる。名前だけでは違いが分からないため。
function Swatch(props: { bg: string; surface: string; accent: string }) {
  return (
    <span class="hwc-theme-swatch" style={{ background: props.bg }}>
      <span class="hwc-theme-swatch-bar" style={{ background: props.surface }} />
      <span class="hwc-theme-swatch-dot" style={{ background: props.accent }} />
    </span>
  );
}

function ThemeButton(props: { theme: ThemeMeta | null; selected: boolean; onSelect: () => void }) {
  const label = props.theme?.label ?? "System";
  return (
    <ChoiceCard selected={props.selected} onSelect={props.onSelect} label={label}>
      {props.theme ? (
        <Swatch {...props.theme.swatch} />
      ) : (
        <span class="hwc-theme-swatch hwc-theme-swatch--system">
          <span class="hwc-theme-split" />
        </span>
      )}
    </ChoiceCard>
  );
}

export function ThemePicker(props: ThemePickerProps) {
  const { modes, light, dark } = themeGroups();
  const [lightTheme, darkTheme] = modes;

  return (
    <div class="hwc-choice-block">
      <div class="hwc-choice-grid hwc-choice-grid--modes" role="radiogroup" aria-label="明るさ">
        <ThemeButton
          theme={null}
          selected={props.value === "system"}
          onSelect={() => props.onChange("system")}
        />
        <ThemeButton
          theme={lightTheme}
          selected={props.value === "light"}
          onSelect={() => props.onChange("light")}
        />
        <ThemeButton
          theme={darkTheme}
          selected={props.value === "dark"}
          onSelect={() => props.onChange("dark")}
        />
      </div>

      <div class="hwc-divider" role="presentation" />

      <div class="hwc-choice-grid" role="radiogroup" aria-label="色テーマ">
        {[...light, ...dark].map((theme) => (
          <ThemeButton
            key={theme.id}
            theme={theme}
            selected={props.value === theme.id}
            onSelect={() => props.onChange(theme.id)}
          />
        ))}
      </div>
    </div>
  );
}
