// 分割に出すかどうかは端末ごとの好み。Herdr の状態ではないので BFF には持たせない。
export const HIDDEN_STORAGE_KEY = "hwc-hidden-panes";

const NO_PANES: ReadonlySet<string> = new Set();

// 壊れた値や別の形の値は「隠していない」に倒す。表示が消えるよりは元に戻せる。
export function parseHiddenPanes(value: string | null): ReadonlySet<string> {
  if (value === null) return NO_PANES;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return NO_PANES;
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return NO_PANES;
  }
}

export function toggleHiddenPanes(
  current: ReadonlySet<string>,
  paneId: string,
): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(paneId)) next.delete(paneId);
  else next.add(paneId);
  return next;
}
