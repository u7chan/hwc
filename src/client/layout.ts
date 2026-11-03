export const SIDEBAR_DEFAULT_WIDTH = 352;
// 3 段の字下げを引いてもペイン名が数文字は残る幅。これ以上狭くすると名前が潰れる。
export const SIDEBAR_MIN_WIDTH = 340;
export const SIDEBAR_MAX_WIDTH = 560;
export const DETAIL_MIN_WIDTH = 360;
export const SIDEBAR_STORAGE_KEY = "hwc-sidebar-width";
export const SIDEBAR_STEP = 16;
// app.css の @media (min-width: 900px) と同じ境目。片方を変えたらもう片方も変える。
export const WIDE_LAYOUT_QUERY = "(min-width: 900px)";

// 分割セルの入力欄を 1 行に畳む条件。これより低いセルでは入力欄が会話を圧迫する。
export const COMPACT_CELL_HEIGHT = 560;
// 幅がこれ未満だと 1 行では入力欄が潰れる。畳まずに通常の composer へ戻す。
export const COMPACT_CELL_MIN_WIDTH = 500;

// 上下に積まれた段か。3 枚は左 1 枚が縦いっぱい、4 枚は全部が 1 段ずつ。枚数から決まる並べ方の
// 事実を app.css の .hwc-split[data-count] とも共有している（3 枚は :first-child の
// grid-row: span 2、4 枚は grid-template-rows: 1fr 1fr）。
export function isStackedCell(count: number, index: number): boolean {
  return count === 4 || (count === 3 && index > 0);
}

// 高さは「未満」、幅は「以上」。積まれた段は高さを見ない（ウィンドウが高くても畳む）。
// 高さの 0 はまだ測っていないセルなので畳まない。
export function isCompactCell(height: number, width: number, stacked: boolean): boolean {
  return (
    width >= COMPACT_CELL_MIN_WIDTH && (stacked || (height > 0 && height < COMPACT_CELL_HEIGHT))
  );
}

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
