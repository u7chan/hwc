// ファイルツリーを会話の左右どちらに並べるかは端末ごとの見え方。Herdr の状態ではないので
// localStorage に置き、BFF には送らない（docs/adr/state-storage.md）。

export type FileTreeSide = "left" | "right";

export const FILE_TREE_SIDE_STORAGE_KEY = "hwc-file-tree-side";

// 並べるときだけ効く。狭いセルでは会話の上に重ねる。
export const DEFAULT_FILE_TREE_SIDE: FileTreeSide = "left";

export const FILE_TREE_SIDES: readonly { id: FileTreeSide; label: string }[] = [
  { id: "left", label: "左" },
  { id: "right", label: "右" },
];

function isFileTreeSide(value: unknown): value is FileTreeSide {
  return FILE_TREE_SIDES.some((option) => option.id === value);
}

// 壊れた値は既定へ倒す。設定の 1 項目なので、読めない値でツリーを消さない。
export function parseFileTreeSide(value: string | null): FileTreeSide {
  return isFileTreeSide(value) ? value : DEFAULT_FILE_TREE_SIDE;
}

type StorageLike = { getItem: (key: string) => string | null };

export function loadFileTreeSide(storage: StorageLike | null): FileTreeSide {
  if (!storage) return DEFAULT_FILE_TREE_SIDE;
  try {
    return parseFileTreeSide(storage.getItem(FILE_TREE_SIDE_STORAGE_KEY));
  } catch {
    // 保存領域が使えない環境では既定に戻す。
    return DEFAULT_FILE_TREE_SIDE;
  }
}

export function saveFileTreeSide(
  storage: Pick<StorageLike, "getItem"> & { setItem: (key: string, value: string) => void },
  side: FileTreeSide,
): void {
  try {
    storage.setItem(FILE_TREE_SIDE_STORAGE_KEY, side);
  } catch {
    // 保存だけ諦める。
  }
}
