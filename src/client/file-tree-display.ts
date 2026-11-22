// ファイルツリーの文字の大きさと幅は端末ごとの見え方。Herdr の状態ではないので localStorage に置き、
// BFF には送らない（docs/adr/state-storage.md）。幅をドラッグではなく段階で選ぶのは、タブレットで
// 掴みにくいため。

export type FileTreeSize = "small" | "normal" | "large";
export type FileTreeWidth = "narrow" | "normal" | "wide";

// 行の高さは変えない（--tap の下限）。変わるのは 1 行に入る文字数だけ。標準は従来の --text-body。
const SIZES: Record<FileTreeSize, { label: string; fontSize: string }> = {
  small: { label: "小", fontSize: "0.875rem" },
  normal: { label: "標準", fontSize: "1.0625rem" },
  large: { label: "大", fontSize: "1.25rem" },
};

// 並べるときだけ効く。狭いセルでは会話の上に重ねるので、幅はセルいっぱいになる。
const WIDTHS: Record<FileTreeWidth, { label: string; width: number }> = {
  narrow: { label: "狭", width: 220 },
  normal: { label: "標準", width: 260 },
  wide: { label: "広", width: 340 },
};

function options<T extends string>(table: Record<T, { label: string }>) {
  return (Object.keys(table) as T[]).map((id) => ({ id, label: table[id].label }));
}

export const FILE_TREE_SIZES = options(SIZES);
export const FILE_TREE_WIDTHS = options(WIDTHS);

export const DEFAULT_FILE_TREE_SIZE: FileTreeSize = "normal";
export const DEFAULT_FILE_TREE_WIDTH: FileTreeWidth = "normal";

export const FILE_TREE_SIZE_STORAGE_KEY = "hwc-file-tree-size";
export const FILE_TREE_WIDTH_STORAGE_KEY = "hwc-file-tree-width";

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

export function saveFileTreeSize(storage: WritableStorage | null, size: FileTreeSize): void {
  save(storage, FILE_TREE_SIZE_STORAGE_KEY, size);
}

export function saveFileTreeWidth(storage: WritableStorage | null, width: FileTreeWidth): void {
  save(storage, FILE_TREE_WIDTH_STORAGE_KEY, width);
}
