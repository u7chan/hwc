import type { AnsiColor } from "./ansi";

export type ColorScheme = "light" | "dark";

type Rgb = { r: number; g: number; b: number };

// 15 テーマの content の地色は、明暗それぞれ狭い範囲に収まる。補正の基準は、
// 前景が最も読みにくくなる側（明るいテーマで最も暗い地、暗いテーマで最も明るい地）に取る。
const REFERENCE_BACKGROUND: Record<ColorScheme, Rgb> = {
  light: { r: 0xef, g: 0xf1, b: 0xf5 }, // Catppuccin Latte
  dark: { r: 0x2d, g: 0x35, b: 0x3b }, // Everforest
};

const MIN_CONTRAST = 4.5;

// 8/16 色はテーマ側で明暗を用意している。256 色と 24bit は端末の値をそのまま使うと
// 地色と近くなり得るので、読みにくいときだけ黒または白へ寄せる（ADR 0046）。
export function ansiCssColor(color: AnsiColor, scheme: ColorScheme): string {
  if (color.kind === "basic") return `var(--ansi-${color.index})`;
  const readable = readableRgb({ r: color.r, g: color.g, b: color.b }, scheme);
  return `rgb(${readable.r} ${readable.g} ${readable.b})`;
}

function readableRgb(color: Rgb, scheme: ColorScheme): Rgb {
  const background = REFERENCE_BACKGROUND[scheme];
  if (contrastRatio(color, background) >= MIN_CONTRAST) return color;

  const target = scheme === "light" ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  let low = 0;
  let high = 1;
  // 16 回で 1/65536 まで詰める。色は 8bit に丸めるので十分。
  for (let step = 0; step < 16; step += 1) {
    const ratio = (low + high) / 2;
    if (contrastRatio(mix(color, target, ratio), background) >= MIN_CONTRAST) high = ratio;
    else low = ratio;
  }
  return mix(color, target, high);
}

function mix(a: Rgb, b: Rgb, ratio: number): Rgb {
  const blend = (from: number, to: number) => Math.round(from + (to - from) * ratio);
  return { r: blend(a.r, b.r), g: blend(a.g, b.g), b: blend(a.b, b.b) };
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
