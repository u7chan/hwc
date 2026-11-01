import type { ThemePreference } from "./theme";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "システム" },
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
];

type ThemePickerProps = {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
};

export function ThemePicker(props: ThemePickerProps) {
  const selectedIndex = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === props.value),
  );

  return (
    <div class="hwc-segments" role="radiogroup" aria-label="テーマ" data-selected={selectedIndex}>
      {OPTIONS.map((option) => (
        <button
          type="button"
          role="radio"
          class="hwc-segment"
          aria-checked={props.value === option.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
