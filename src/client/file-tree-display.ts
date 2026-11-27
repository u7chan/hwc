// ファイルツリーの文字の大きさ・幅・印は端末ごとの見え方。Herdr の状態ではないので localStorage に置き、
// BFF には送らない（docs/adr/state-storage.md）。幅だけは設定の段階では選ばず、並べたツリーの境目を
// ドラッグして決める。段階は粗く、実際のファイル名の切れ方を見ながら合わせられないため。

import type { FileTreeSide } from "./file-tree-side";
import { treeSideMaxWidth } from "./layout";

export type FileTreeSize = "small" | "normal" | "large";
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
export const FILE_TREE_ICONS = options(ICONS);

// 行の右端のメニューボタンが、名前に数文字を残す幅。これより狭いと名前が潰れる。
export const FILE_TREE_WIDTH_MIN = 180;
export const FILE_TREE_WIDTH_MAX = 480;
export const FILE_TREE_WIDTH_STEP = 16;

export const DEFAULT_FILE_TREE_SIZE: FileTreeSize = "normal";
export const DEFAULT_FILE_TREE_WIDTH = 260;
export const DEFAULT_FILE_TREE_ICONS: FileTreeIcons = "none";

export const FILE_TREE_SIZE_STORAGE_KEY = "hwc-file-tree-size";
export const FILE_TREE_WIDTH_STORAGE_KEY = "hwc-file-tree-width";
export const FILE_TREE_ICONS_STORAGE_KEY = "hwc-file-tree-icons";

export function fileTreeFontSize(size: FileTreeSize): string {
  return SIZES[size].fontSize;
}

// cellWidth はドラッグしているセルの幅。省略すると、セルに左右されない保存用の範囲で丸める。
export function clampFileTreeWidth(width: number, cellWidth = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(width)) return DEFAULT_FILE_TREE_WIDTH;
  const max = Math.max(
    FILE_TREE_WIDTH_MIN,
    Math.min(FILE_TREE_WIDTH_MAX, treeSideMaxWidth(cellWidth)),
  );
  return Math.min(max, Math.max(FILE_TREE_WIDTH_MIN, Math.round(width)));
}

// 境目を右へ動かすと、左に並べたツリーは広がり、右に並べたツリーは狭まる。
export function fileTreeWidthByDrag(start: number, dx: number, side: FileTreeSide): number {
  return side === "left" ? start + dx : start - dx;
}

type StorageLike = { getItem: (key: string) => string | null };
type WritableStorage = StorageLike & { setItem: (key: string, value: string) => void };

// 壊れた値は既定へ倒す。設定の 1 項目なので、読めない値でツリーを崩さない。
export function parseFileTreeSize(value: string | null): FileTreeSize {
  return FILE_TREE_SIZES.find((option) => option.id === value)?.id ?? DEFAULT_FILE_TREE_SIZE;
}

export function parseFileTreeWidth(value: string | null): number {
  return value === null ? DEFAULT_FILE_TREE_WIDTH : clampFileTreeWidth(Number(value));
}

export function parseFileTreeIcons(value: string | null): FileTreeIcons {
  return FILE_TREE_ICONS.find((option) => option.id === value)?.id ?? DEFAULT_FILE_TREE_ICONS;
}

function load<T>(storage: StorageLike | null, key: string, parse: (value: string | null) => T): T {
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

export function loadFileTreeWidth(storage: StorageLike | null): number {
  return load(storage, FILE_TREE_WIDTH_STORAGE_KEY, parseFileTreeWidth);
}

export function loadFileTreeIcons(storage: StorageLike | null): FileTreeIcons {
  return load(storage, FILE_TREE_ICONS_STORAGE_KEY, parseFileTreeIcons);
}

export function saveFileTreeSize(storage: WritableStorage | null, size: FileTreeSize): void {
  save(storage, FILE_TREE_SIZE_STORAGE_KEY, size);
}

// 書く値も clamp する。読む側の parse と範囲を揃え、保存形式に範囲外の数値を残さない。
export function saveFileTreeWidth(storage: WritableStorage | null, width: number): void {
  save(storage, FILE_TREE_WIDTH_STORAGE_KEY, String(clampFileTreeWidth(width)));
}

export function saveFileTreeIcons(storage: WritableStorage | null, icons: FileTreeIcons): void {
  save(storage, FILE_TREE_ICONS_STORAGE_KEY, icons);
}
