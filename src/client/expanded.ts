// ツリーの開閉は端末ごとの見え方。Herdr の状態ではないので BFF には持たせない。
// 既定の開閉（initialExpanded）からの差分だけを id ごとに覚える。新しいワークスペースや
// タブは既定に従うので、保存に無い id があっても勝手に閉じない。
export const OPEN_GROUPS_STORAGE_KEY = "hwc-open-groups";

const NO_GROUPS: ReadonlyMap<string, boolean> = new Map();

// 壊れた値や真偽値でない項目は捨てる。開閉が戻るだけで、一覧は使える。
export function parseOpenGroups(value: string | null): ReadonlyMap<string, boolean> {
  if (value === null) return NO_GROUPS;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_GROUPS;
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    );
    return entries.length === 0 ? NO_GROUPS : new Map(entries);
  } catch {
    return NO_GROUPS;
  }
}

type StorageLike = { getItem: (key: string) => string | null };
type WritableStorage = StorageLike & { setItem: (key: string, value: string) => void };

export function loadOpenGroups(storage: StorageLike | null): ReadonlyMap<string, boolean> {
  if (!storage) return NO_GROUPS;
  try {
    return parseOpenGroups(storage.getItem(OPEN_GROUPS_STORAGE_KEY));
  } catch {
    // 保存領域が使えない環境では、何も覚えていない扱いにする。
    return NO_GROUPS;
  }
}

// 覚えた差分は 1 つの JSON にまとめる。グループごとにキーを分けると、消えた id の掃除が要る。
export function saveOpenGroups(
  storage: WritableStorage | null,
  groups: ReadonlyMap<string, boolean>,
): void {
  if (!storage) return;
  try {
    storage.setItem(OPEN_GROUPS_STORAGE_KEY, JSON.stringify(Object.fromEntries(groups)));
  } catch {
    // 保存だけ諦める。
  }
}

export function rememberGroup(
  stored: ReadonlyMap<string, boolean>,
  groupId: string,
  open: boolean,
): ReadonlyMap<string, boolean> {
  const next = new Map(stored);
  next.set(groupId, open);
  return next;
}

// 消えたグループの記録は無視する。戻ってきたときに前の開閉を復元したければ残しておくが、
// 一覧に無い id を開いた状態にはしない。
export function applyOpenGroups(
  base: ReadonlySet<string>,
  stored: ReadonlyMap<string, boolean>,
  existing: ReadonlySet<string>,
): Set<string> {
  const next = new Set(base);
  for (const [groupId, open] of stored) {
    if (!existing.has(groupId)) continue;
    if (open) next.add(groupId);
    else next.delete(groupId);
  }
  return next;
}
