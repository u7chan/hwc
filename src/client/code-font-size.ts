// ファイルプレビューのソース表示の文字の大きさは端末ごとの見え方。Herdr の状態ではないので
// localStorage に置き、BFF には送らない（docs/adr/state-storage.md）。Markdown の本文や会話・
// 端末出力は対象にしない。桁を追う読み物と、折り返して読む文章では、ちょうどよい大きさが違う。

export type CodeFontSize = "small" | "normal" | "large";

// 標準は従来の --text-mono そのもの。--text-mono を基準の倍率にするのは、ファイルツリーと
// 同じ理由で、どの画面幅でも標準との比を揃えるため。行間は無次元の --line-body なので追従する。
const SIZES: Record<CodeFontSize, { label: string; fontSize: string }> = {
  small: { label: "小", fontSize: "calc(var(--text-mono) * 0.75)" },
  normal: { label: "標準", fontSize: "var(--text-mono)" },
  large: { label: "大", fontSize: "calc(var(--text-mono) * 1.35)" },
};

export const CODE_FONT_SIZES = (Object.keys(SIZES) as CodeFontSize[]).map((id) => ({
  id,
  label: SIZES[id].label,
}));

export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = "normal";
export const CODE_FONT_SIZE_STORAGE_KEY = "hwc-code-font-size";

export function codeFontSize(size: CodeFontSize): string {
  return SIZES[size].fontSize;
}

type StorageLike = { getItem: (key: string) => string | null };
type WritableStorage = StorageLike & { setItem: (key: string, value: string) => void };

// 壊れた値は既定へ倒す。設定の 1 項目なので、読めない値でプレビューを崩さない。
export function parseCodeFontSize(value: string | null): CodeFontSize {
  return CODE_FONT_SIZES.find((option) => option.id === value)?.id ?? DEFAULT_CODE_FONT_SIZE;
}

export function loadCodeFontSize(storage: StorageLike | null): CodeFontSize {
  try {
    return parseCodeFontSize(storage ? storage.getItem(CODE_FONT_SIZE_STORAGE_KEY) : null);
  } catch {
    // 保存領域が使えない環境では既定に戻す。
    return DEFAULT_CODE_FONT_SIZE;
  }
}

export function saveCodeFontSize(storage: WritableStorage | null, size: CodeFontSize): void {
  if (!storage) return;
  try {
    storage.setItem(CODE_FONT_SIZE_STORAGE_KEY, size);
  } catch {
    // 保存だけ諦める。
  }
}
