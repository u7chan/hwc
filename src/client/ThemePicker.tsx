import { ChoiceCard } from "./ChoiceCard";
import { SendIcon, StatusMark } from "./icons";
import { StatusIcon } from "./StatusLabel";
import { THEMES, themeGroups, type ThemeMeta, type ThemePreference } from "./theme";

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

function selectedThemeLabel(value: ThemePreference): string {
  if (value === "system") return "System（端末に追従）";
  return THEMES.find((theme) => theme.id === value)?.label ?? "";
}

// 設定画面には出ない状態色とアクセント面を、いまのテーマで見せる。テーマを選ぶと
// 画面全体が切り替わり、このプレビューも同じトークンで描き直される。
function ThemePreview(props: { label: string }) {
  return (
    <div class="hwc-theme-preview">
      <p class="hwc-theme-preview-caption">選択中: {props.label}</p>
      <div class="hwc-theme-preview-inner" aria-hidden="true">
        <div class="hwc-theme-preview-row">
          <span class="hwc-theme-preview-status">
            <StatusIcon status="working" />
            実行中
          </span>
          <span class="hwc-theme-preview-status">
            <span class="hwc-status hwc-status--attention">
              <StatusMark tone="attention" size={18} />
            </span>
            要対応
          </span>
          <span class="hwc-theme-preview-status">
            <span class="hwc-status hwc-status--success">
              <StatusMark tone="success" size={18} />
            </span>
            完了
          </span>
        </div>
        <div class="hwc-theme-preview-row">
          <span class="hwc-theme-preview-link">リンク</span>
          <span class="hwc-theme-preview-focus">フォーカス</span>
        </div>
        <div class="hwc-theme-preview-row">
          <span class="hwc-send hwc-theme-preview-send">
            <SendIcon />
          </span>
          <span class="hwc-theme-preview-note">送信</span>
        </div>
      </div>
    </div>
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
      <ThemePreview label={selectedThemeLabel(props.value)} />

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
