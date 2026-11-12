import { useState } from "preact/hooks";
import { ChoiceCard } from "./ChoiceCard";
import { ChevronRightIcon, SendIcon, StatusMark } from "./icons";
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

const PREVIEW_BODY_ID = "hwc-theme-preview-body";

// 設定画面には出ない状態色とアクセント面を、いまのテーマで見せる。テーマを選ぶと
// 画面全体が切り替わり、このプレビューも同じトークンで描き直される。
// 既定は畳む。常に開いておくとテーマ一覧の上で高さを取り、通知まで遠くなる。
function ThemePreview(props: { label: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div class="hwc-theme-preview">
      <button
        type="button"
        class="hwc-theme-preview-head"
        aria-expanded={open}
        aria-controls={PREVIEW_BODY_ID}
        onClick={() => setOpen((value) => !value)}
      >
        <span>選択中: {props.label}</span>
        <span class="hwc-theme-preview-icon">
          <ChevronRightIcon size={16} />
        </span>
      </button>

      <div class="hwc-theme-preview-body" id={PREVIEW_BODY_ID} data-open={open}>
        <div class="hwc-theme-preview-clip">
          <div class="hwc-theme-preview-inner" aria-hidden="true">
            {/* 吹き出しは会話と同じ記号で見せる。見本に写しを持つと、後にアクセント面や
                on-accent を変えたとき、見本だけが古い色のまま残る。 */}
            <div class="hwc-msg hwc-theme-preview-msg" data-role="user">
              <div class="hwc-msg-bubble">このテーマで送信します</div>
            </div>

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
