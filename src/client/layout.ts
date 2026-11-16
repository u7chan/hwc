export const SIDEBAR_DEFAULT_WIDTH = 352;
// 3 段の字下げを引いてもペイン名が数文字は残る幅。これ以上狭くすると名前が潰れる。
export const SIDEBAR_MIN_WIDTH = 340;
export const SIDEBAR_MAX_WIDTH = 560;
export const DETAIL_MIN_WIDTH = 360;
export const SIDEBAR_STORAGE_KEY = "hwc-sidebar-width";
export const SIDEBAR_STEP = 16;
// app.css の @media (min-width: 900px) と同じ境目。片方を変えたらもう片方も変える。
export const WIDE_LAYOUT_QUERY = "(min-width: 900px)";

// ファイルツリーを会話の左に並べる最小のセル幅。ツリーの 260px（--hwc-tree-width）を
// 引いても、本文に 420px 残る幅。狭いセルでは会話の上に重ねる（ADR 0090）。
export const TREE_SIDE_MIN_WIDTH = 680;

// 設定でカテゴリを左に常設するのに要る、詳細側の幅。カテゴリ列（260）と左右の余白（64）を
// 引いても、内容にスマホ相当（400）が残る幅。狭ければ 1 カラムの一覧に戻す。
export const SETTINGS_SIDE_MIN_WIDTH = 724;

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
