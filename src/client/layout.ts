export const SIDEBAR_DEFAULT_WIDTH = 352;
// 3 段の字下げを引いてもペイン名が数文字は残る幅。これ以上狭くすると名前が潰れる。
export const SIDEBAR_MIN_WIDTH = 340;
export const SIDEBAR_MAX_WIDTH = 560;
export const DETAIL_MIN_WIDTH = 360;
export const SIDEBAR_STORAGE_KEY = "hwc-sidebar-width";
export const SIDEBAR_STEP = 16;
// styles.css の @media (min-width: 900px) と同じ境目。片方を変えたらもう片方も変える。
export const WIDE_LAYOUT_QUERY = "(min-width: 900px)";

export function clampSidebarWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  const max = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - DETAIL_MIN_WIDTH),
  );
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function parseSidebarWidth(value: string | null, viewportWidth?: number): number {
  if (value === null) return clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, viewportWidth);
  const width = Number(value);
  return Number.isFinite(width)
    ? clampSidebarWidth(width, viewportWidth)
    : clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, viewportWidth);
}
