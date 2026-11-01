import { THEMES, type ThemePreference } from "./theme";

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

export function ThemePicker(props: ThemePickerProps) {
  return (
    <div class="hwc-themes" role="radiogroup" aria-label="テーマ">
      <button
        type="button"
        role="radio"
        class="hwc-theme"
        aria-checked={props.value === "system"}
        data-selected={props.value === "system"}
        onClick={() => props.onChange("system")}
      >
        <span class="hwc-theme-swatch hwc-theme-swatch--system">
          <span class="hwc-theme-split" />
        </span>
        <span class="hwc-theme-name" title="システム">
          システム
        </span>
      </button>
      {THEMES.map((theme) => (
        <button
          type="button"
          role="radio"
          class="hwc-theme"
          key={theme.id}
          aria-checked={props.value === theme.id}
          data-selected={props.value === theme.id}
          onClick={() => props.onChange(theme.id)}
        >
          <Swatch {...theme.swatch} />
          <span class="hwc-theme-name" title={theme.label}>
            {theme.label}
          </span>
        </button>
      ))}
    </div>
  );
}
