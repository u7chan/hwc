export const SIDEBAR_DEFAULT_WIDTH = 352;
// 3 段の字下げを引いてもペイン名が数文字は残る幅。これ以上狭くすると名前が潰れる。
export const SIDEBAR_MIN_WIDTH = 340;
export const SIDEBAR_MAX_WIDTH = 560;
export const DETAIL_MIN_WIDTH = 360;
export const SIDEBAR_STORAGE_KEY = "hwc-sidebar-width";
export const SIDEBAR_STEP = 16;
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "hwc-sidebar-collapsed";
// app.css の @media (min-width: 900px) と同じ境目。片方を変えたらもう片方も変える。
export const WIDE_LAYOUT_QUERY = "(min-width: 900px)";

// ファイルツリーを並べたとき、会話に残す最小の幅。
const TREE_BODY_MIN_WIDTH = 420;

// ファイルツリーを会話の左右どちらかに並べる最小のセル幅。ツリーの幅（--hwc-tree-width）を
// 引いても、本文に 420px 残る幅。狭いセルでは会話の上に重ねる。ツリーの幅は設定で変わるので、
// 固定値ではなく幅から導く。
export function treeSideMinWidth(treeWidth: number): number {
  return treeWidth + TREE_BODY_MIN_WIDTH;
}

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

// 保存された値が壊れていても一覧は隠さない。隠したまま開き方が分からなくなるより、開いて戻る方がよい。
export function parseSidebarCollapsed(value: string | null): boolean {
  return value === "true";
}

type StorageLike = { getItem: (key: string) => string | null };
type WritableStorage = StorageLike & { setItem: (key: string, value: string) => void };

export function loadSidebarWidth(storage: StorageLike | null): number {
  if (!storage) return parseSidebarWidth(null);
  try {
    return parseSidebarWidth(storage.getItem(SIDEBAR_STORAGE_KEY));
  } catch {
    // 保存領域が使えない環境では既定の幅に戻す。
    return parseSidebarWidth(null);
  }
}

// 書く値も clamp する。読む側の parse と範囲を揃え、保存形式に範囲外の数値を残さない。
export function saveSidebarWidth(storage: WritableStorage | null, width: number): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // 保存だけ諦める。
  }
}

export function loadSidebarCollapsed(storage: StorageLike | null): boolean {
  if (!storage) return parseSidebarCollapsed(null);
  try {
    return parseSidebarCollapsed(storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY));
  } catch {
    // 保存領域が使えない環境では、一覧を開いたままにする。
    return parseSidebarCollapsed(null);
  }
}

export function saveSidebarCollapsed(storage: WritableStorage | null, collapsed: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // 保存だけ諦める。
  }
}
