type SpinnerProps = { size?: number };

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": "true" as const,
    focusable: "false" as const,
  };
}

export function Spinner({ size = 20 }: SpinnerProps) {
  return (
    <svg {...svgProps(size)}>
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

// 処理中であることだけを示す。色は文字色に合わせる。
export function SpinnerDots({ size = 12 }: SpinnerProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="3" r="0">
        <animate
          id="hwc-spin-1"
          begin="0;hwc-spin-3.end-0.5s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="16.50" cy="4.21" r="0">
        <animate
          id="hwc-spin-2"
          begin="hwc-spin-1.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="7.50" cy="4.21" r="0">
        <animate
          id="hwc-spin-3"
          begin="hwc-spin-5.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="19.79" cy="7.50" r="0">
        <animate
          id="hwc-spin-4"
          begin="hwc-spin-2.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="4.21" cy="7.50" r="0">
        <animate
          id="hwc-spin-5"
          begin="hwc-spin-7.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="21.00" cy="12.00" r="0">
        <animate
          id="hwc-spin-6"
          begin="hwc-spin-4.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="3.00" cy="12.00" r="0">
        <animate
          id="hwc-spin-7"
          begin="hwc-spin-9.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="19.79" cy="16.50" r="0">
        <animate
          id="hwc-spin-8"
          begin="hwc-spin-6.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="4.21" cy="16.50" r="0">
        <animate
          id="hwc-spin-9"
          begin="hwc-spin-11.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="16.50" cy="19.79" r="0">
        <animate
          id="hwc-spin-10"
          begin="hwc-spin-8.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="7.50" cy="19.79" r="0">
        <animate
          id="hwc-spin-11"
          begin="hwc-spin-12.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
      <circle cx="12" cy="21" r="0">
        <animate
          id="hwc-spin-12"
          begin="hwc-spin-10.begin+0.1s"
          attributeName="r"
          calcMode="spline"
          dur="0.6s"
          values="0;2;0"
          keySplines=".27,.42,.37,.99;.53,0,.61,.73"
        />
      </circle>
    </svg>
  );
}
