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
    <button
      type="button"
      role="radio"
      class="hwc-theme"
      aria-checked={props.selected}
      data-selected={props.selected}
      onClick={props.onSelect}
    >
      {props.theme ? (
        <Swatch {...props.theme.swatch} />
      ) : (
        <span class="hwc-theme-swatch hwc-theme-swatch--system">
          <span class="hwc-theme-split" />
        </span>
      )}
      <span class="hwc-theme-name" title={label}>
        {label}
      </span>
    </button>
  );
}

export function ThemePicker(props: ThemePickerProps) {
  const { modes, light, dark } = themeGroups();
  const [lightTheme, darkTheme] = modes;

  return (
    <div class="hwc-theme-block">
      <div class="hwc-themes hwc-themes--modes" role="radiogroup" aria-label="明るさ">
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

      <div class="hwc-themes" role="radiogroup" aria-label="色テーマ">
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
