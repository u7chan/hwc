type SpinnerProps = { size?: number };

// 回転は CSS で回す。SMIL は生成順や id 参照に弱く、ループが止まることがある。
export function Spinner({ size = 20 }: SpinnerProps) {
  return (
    <svg
      class="hwc-arc"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.14,1.16a11,11,0,0,0-9,8.92A1.59,1.59,0,0,0,2.46,12,1.52,1.52,0,0,0,4.11,10.7a8,8,0,0,1,6.66-6.61A1.42,1.42,0,0,0,12,2.69h0A1.57,1.57,0,0,0,10.14,1.16Z" />
    </svg>
  );
}

// 処理中。薄い輪と、その上を回る弧。
export function WorkingMark({ size = 12 }: SpinnerProps) {
  return (
    <svg
      class="hwc-working"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12,1A11,11,0,1,0,23,12,11,11,0,0,0,12,1Zm0,19a8,8,0,1,1,8-8A8,8,0,0,1,12,20Z"
        opacity=".25"
      />
      <path
        class="hwc-arc-turn"
        d="M10.72,19.9a8,8,0,0,1-6.5-9.79A7.77,7.77,0,0,1,10.4,4.16a8,8,0,0,1,9.49,6.52A1.54,1.54,0,0,0,21.38,12h.13a1.37,1.37,0,0,0,1.38-1.54,11,11,0,1,0-12.7,12.39A1.54,1.54,0,0,0,12,21.34h0A1.47,1.47,0,0,0,10.72,19.9Z"
      />
    </svg>
  );
}

// 3×3 の四角が斜めに縮んでいく。
const SQUARE_GRID: [number, number, number][] = [
  [1, 1, 0],
  [8.33, 1, 0.1],
  [1, 8.33, 0.1],
  [15.66, 1, 0.2],
  [8.33, 8.33, 0.2],
  [1, 15.66, 0.2],
  [15.66, 8.33, 0.3],
  [8.33, 15.66, 0.3],
  [15.66, 15.66, 0.4],
];

export function AttentionMark({ size = 12 }: SpinnerProps) {
  return (
    <svg
      class="hwc-grid"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {SQUARE_GRID.map(([x, y, delay]) => (
        <rect x={x} y={y} width="7.33" height="7.33" style={{ animationDelay: `${delay}s` }} />
      ))}
    </svg>
  );
}
