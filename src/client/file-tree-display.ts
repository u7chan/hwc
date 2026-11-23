// ファイルツリーの文字の大きさと幅は端末ごとの見え方。Herdr の状態ではないので localStorage に置き、
// BFF には送らない（docs/adr/state-storage.md）。幅をドラッグではなく段階で選ぶのは、タブレットで
// 掴みにくいため。

export type FileTreeSize = "small" | "normal" | "large";
export type FileTreeWidth = "narrow" | "normal" | "wide";
// 行の左に種類の印を出すか。既定は出さない（設定を足す前の見た目）。
export type FileTreeIcons = "none" | "color";

// 行の高さは変えない（--tap の下限）。変わるのは 1 行に入る文字数だけ。標準は従来の --text-body
// そのもので、画面幅で変わる（900px 以上は 0.9375rem）。小と大はその倍率にして、どの幅でも
// 標準との比が同じになるようにする。固定の rem にすると、広い画面で標準との差が揃わない。
const SIZES: Record<FileTreeSize, { label: string; fontSize: string }> = {
  small: { label: "小", fontSize: "calc(var(--text-body) * 0.85)" },
  normal: { label: "標準", fontSize: "var(--text-body)" },
  large: { label: "大", fontSize: "calc(var(--text-body) * 1.2)" },
};

// 並べるときだけ効く。狭いセルでは会話の上に重ねるので、幅はセルいっぱいになる。
const WIDTHS: Record<FileTreeWidth, { label: string; width: number }> = {
  narrow: { label: "狭", width: 220 },
  normal: { label: "標準", width: 260 },
  wide: { label: "広", width: 340 },
};

// 印は種類ごとに色を変える 1 通りだけ。色を付けない形だけの案は、テーマ 20 種すべてで
// 地の文字色に寄ってしまい、種類を見分ける役に立たないため選ばなかった。
const ICONS: Record<FileTreeIcons, { label: string }> = {
  none: { label: "なし" },
  color: { label: "色分け" },
};

function options<T extends string>(table: Record<T, { label: string }>) {
  return (Object.keys(table) as T[]).map((id) => ({ id, label: table[id].label }));
}

export const FILE_TREE_SIZES = options(SIZES);
export const FILE_TREE_WIDTHS = options(WIDTHS);
export const FILE_TREE_ICONS = options(ICONS);

export const DEFAULT_FILE_TREE_SIZE: FileTreeSize = "normal";
export const DEFAULT_FILE_TREE_WIDTH: FileTreeWidth = "normal";
export const DEFAULT_FILE_TREE_ICONS: FileTreeIcons = "none";

export const FILE_TREE_SIZE_STORAGE_KEY = "hwc-file-tree-size";
export const FILE_TREE_WIDTH_STORAGE_KEY = "hwc-file-tree-width";
export const FILE_TREE_ICONS_STORAGE_KEY = "hwc-file-tree-icons";

export function fileTreeFontSize(size: FileTreeSize): string {
  return SIZES[size].fontSize;
}

export function fileTreeWidthPx(width: FileTreeWidth): number {
  return WIDTHS[width].width;
}

type StorageLike = { getItem: (key: string) => string | null };
type WritableStorage = StorageLike & { setItem: (key: string, value: string) => void };

// 壊れた値は既定へ倒す。設定の 1 項目なので、読めない値でツリーを崩さない。
export function parseFileTreeSize(value: string | null): FileTreeSize {
  return FILE_TREE_SIZES.find((option) => option.id === value)?.id ?? DEFAULT_FILE_TREE_SIZE;
}

export function parseFileTreeWidth(value: string | null): FileTreeWidth {
  return FILE_TREE_WIDTHS.find((option) => option.id === value)?.id ?? DEFAULT_FILE_TREE_WIDTH;
}

export function parseFileTreeIcons(value: string | null): FileTreeIcons {
  return FILE_TREE_ICONS.find((option) => option.id === value)?.id ?? DEFAULT_FILE_TREE_ICONS;
}

function load<T extends string>(
  storage: StorageLike | null,
  key: string,
  parse: (value: string | null) => T,
): T {
  try {
    return parse(storage ? storage.getItem(key) : null);
  } catch {
    // 保存領域が使えない環境では既定に戻す。
    return parse(null);
  }
}

function save(storage: WritableStorage | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // 保存だけ諦める。
  }
}

export function loadFileTreeSize(storage: StorageLike | null): FileTreeSize {
  return load(storage, FILE_TREE_SIZE_STORAGE_KEY, parseFileTreeSize);
}

export function loadFileTreeWidth(storage: StorageLike | null): FileTreeWidth {
  return load(storage, FILE_TREE_WIDTH_STORAGE_KEY, parseFileTreeWidth);
}

export function loadFileTreeIcons(storage: StorageLike | null): FileTreeIcons {
  return load(storage, FILE_TREE_ICONS_STORAGE_KEY, parseFileTreeIcons);
}

export function saveFileTreeSize(storage: WritableStorage | null, size: FileTreeSize): void {
  save(storage, FILE_TREE_SIZE_STORAGE_KEY, size);
}

export function saveFileTreeWidth(storage: WritableStorage | null, width: FileTreeWidth): void {
  save(storage, FILE_TREE_WIDTH_STORAGE_KEY, width);
}

export function saveFileTreeIcons(storage: WritableStorage | null, icons: FileTreeIcons): void {
  save(storage, FILE_TREE_ICONS_STORAGE_KEY, icons);
}
