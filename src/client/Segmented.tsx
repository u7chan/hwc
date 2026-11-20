import type { ComponentChildren } from "preact";

export type SegmentedOption<T extends string> = {
  id: T;
  label: string;
  icon?: ComponentChildren;
};

// 選んだ面は、選ぶたびにボタンへ塗り直さず 1 枚のつまみとして滑らせる。押した位置と
// 選ばれた位置の対応を、切り替えの間も見せるため（一覧の「すべて / アクティブ」と同じ動き）。
export function Segmented<T extends string>(props: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  disabled?: boolean;
  onChange: (id: T) => void;
}) {
  // 値がどれにも当たらなければ先頭へ寄せる。つまみを列の外へ出さない。
  const current = Math.max(
    props.options.findIndex((option) => option.id === props.value),
    0,
  );

  return (
    <div
      class="hwc-segmented"
      role="radiogroup"
      aria-label={props.label}
      // つまみの幅は列数、位置は選ばれている列で決まる。どちらも描画のたびに変わるので、CSS へ渡す。
      style={{ "--hwc-segments": String(props.options.length), "--hwc-segment": String(current) }}
    >
      <span class="hwc-segmented-thumb" aria-hidden="true" />
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          class="hwc-segment"
          aria-checked={props.value === option.id}
          disabled={props.disabled}
          onClick={() => props.onChange(option.id)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}
