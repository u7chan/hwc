type SpinnerProps = { size?: number };

export function Spinner({ size = 20 }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.14,1.16a11,11,0,0,0-9,8.92A1.59,1.59,0,0,0,2.46,12,1.52,1.52,0,0,0,4.11,10.7a8,8,0,0,1,6.66-6.61A1.42,1.42,0,0,0,12,2.69h0A1.57,1.57,0,0,0,10.14,1.16Z">
        <animateTransform
          attributeName="transform"
          type="rotate"
          dur="0.75s"
          values="0 12 12;360 12 12"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

// 時計回りに 12 個。CSS の animation-delay で順に光らせる。
const DOT_RING: [number, number][] = [
  [12, 3],
  [16.5, 4.21],
  [19.79, 7.5],
  [21, 12],
  [19.79, 16.5],
  [16.5, 19.79],
  [12, 21],
  [7.5, 19.79],
  [4.21, 16.5],
  [3, 12],
  [4.21, 7.5],
  [7.5, 4.21],
];

// 処理中であることだけを示す。色は文字色に合わせる。
export function SpinnerDots({ size = 12 }: SpinnerProps) {
  return (
    <svg
      class="hwc-dots"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {DOT_RING.map(([cx, cy], index) => (
        <circle cx={cx} cy={cy} r="2" style={{ animationDelay: `${index * 0.05}s` }} />
      ))}
    </svg>
  );
}

// 塗りが抜けてから枠が半回転する。SMIL の id 参照は生成順に弱いので CSS で回す。
export function AttentionMark({ size = 12 }: SpinnerProps) {
  return (
    <svg
      class="hwc-attention"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        class="hwc-attention-outline"
        fill="none"
        stroke="currentColor"
        stroke-width="4"
        x="25"
        y="25"
        width="50"
        height="50"
      />
      <rect class="hwc-attention-fill" x="27" y="27" fill="currentColor" width="46" height="50" />
    </svg>
  );
}
