import type { ComponentChildren } from "preact";

type ChoiceCardProps = {
  selected: boolean;
  onSelect: () => void;
  label: string;
  disabled?: boolean;
  children: ComponentChildren;
};

// 設定のテーマと作成ダイアログのエージェントで同じ見た目を使う。選択の印は枠と面で付け、
// 太字にしない。文字幅が変わると、狭い画面で折り返しと行の高さが動いてしまう。
export function ChoiceCard(props: ChoiceCardProps) {
  return (
    <button
      type="button"
      role="radio"
      class="hwc-choice"
      aria-checked={props.selected}
      data-selected={props.selected}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      <span class="hwc-choice-visual">{props.children}</span>
      <span class="hwc-choice-label" title={props.label}>
        {props.label}
      </span>
    </button>
  );
}
