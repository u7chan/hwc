// 分割ビューの状態。開いたペインの履歴（openTabs）、選択（current）、4 スロットのグリッド
// （slots）だけを持ち、Herdr の状態は持たない（ADR 0058）。
export const MAX_SLOTS = 4;

export type SplitView = {
  // 開いた順。全スペースを跨ぎ、一意で、実在するペインだけ。
  openTabs: readonly string[];
  // 選択中のペイン。消えたペインの ID を保持することがある（ADR 0021）。
  current: string | null;
  // 長さ 0〜4。空きは null。一意で openTabs の部分集合。
  slots: readonly (string | null)[];
};

export const EMPTY_SPLIT_VIEW: SplitView = { openTabs: [], current: null, slots: [] };

// 保存も再読み込みもしない、初回表示の状態。開いていたペインが無ければ一覧から始める。
export function startSplitView(paneId: string | null): SplitView {
  return paneId === null
    ? EMPTY_SPLIT_VIEW
    : { openTabs: [paneId], current: paneId, slots: [paneId] };
}

export function currentSlotIndex(view: SplitView): number {
  if (view.current === null) return -1;
  return view.slots.indexOf(view.current);
}

// タブとスロットの色は位置で決まる。同じペインは 1 つのスロットにしか入らない。
export function slotIndexOf(view: SplitView, paneId: string): number {
  return view.slots.indexOf(paneId);
}

export function multiSpace(workspaceIds: readonly string[]): boolean {
  return new Set(workspaceIds).size > 1;
}

function replaceAt(
  slots: readonly (string | null)[],
  index: number,
  value: string | null,
): (string | null)[] {
  const next = [...slots];
  next[index] = value;
  return next;
}

// 空きスロットの先頭。空きが無ければ -1。
function firstEmptySlot(slots: readonly (string | null)[]): number {
  return slots.indexOf(null);
}

// グリッドへ 1 枚入れる。空き先頭、空きが無ければ末尾（4 未満）、4 枚揃っていれば先頭を置換。
export function placeInSlots(slots: readonly (string | null)[], paneId: string): (string | null)[] {
  const empty = firstEmptySlot(slots);
  if (empty >= 0) return replaceAt(slots, empty, paneId);
  if (slots.length < MAX_SLOTS) return [...slots, paneId];
  return replaceAt(slots, 0, paneId);
}

// 一覧・タブからペインを開く。開いていなければタブの右端に積み、グリッドは current の
// スロットを置き換える（グリッド外のタブを選んだときの規則）。
export function openPane(view: SplitView, paneId: string): SplitView {
  const openTabs = view.openTabs.includes(paneId) ? view.openTabs : [...view.openTabs, paneId];
  if (view.slots.includes(paneId)) return { openTabs, current: paneId, slots: view.slots };
  const at = view.current === null ? -1 : view.slots.indexOf(view.current);
  const slots = at >= 0 ? replaceAt(view.slots, at, paneId) : placeInSlots(view.slots, paneId);
  return { openTabs, current: paneId, slots };
}

// 一覧へ戻す。開いたタブとスロットは残す。
export function clearCurrent(view: SplitView): SplitView {
  return { openTabs: view.openTabs, current: null, slots: view.slots };
}

// 閉じたペインの後継。開いた順の次を探し、無ければ手前へ戻る。
export function nextOpenPane(openTabs: readonly string[], paneId: string): string | null {
  const at = openTabs.indexOf(paneId);
  if (at < 0) return null;
  const after = openTabs.slice(at + 1).find((id) => id !== paneId);
  if (after !== undefined) return after;
  const before = openTabs
    .slice(0, at)
    .reverse()
    .find((id) => id !== paneId);
  return before ?? null;
}

// タブを閉じる。current を閉じたときだけ選択を後継へ動かす。後継がグリッド内ならその
// スロットを current にし、グリッド外なら閉じたペインのスロットへ入れる。
export function closeTab(view: SplitView, paneId: string, successor?: string | null): SplitView {
  if (!view.openTabs.includes(paneId)) return view;
  const openTabs = view.openTabs.filter((id) => id !== paneId);
  const at = view.slots.indexOf(paneId);
  const slots = at >= 0 ? replaceAt(view.slots, at, null) : view.slots;
  if (view.current !== paneId) return { openTabs, current: view.current, slots };

  const next = successor === undefined ? nextOpenPane(view.openTabs, paneId) : successor;
  if (next === null || next === paneId || !openTabs.includes(next)) {
    return { openTabs, current: null, slots };
  }
  if (slots.includes(next)) return { openTabs, current: next, slots };
  const placed = at >= 0 ? replaceAt(slots, at, next) : placeInSlots(slots, next);
  return { openTabs, current: next, slots: placed };
}

// ドラッグしたペインをスロットへ落とす。openTabs は変えない。
export function dropOnSlot(view: SplitView, paneId: string, target: number): SplitView {
  if (target < 0 || target >= view.slots.length) return view;
  const from = view.slots.indexOf(paneId);
  if (from === target) return view;
  const slots = [...view.slots];
  const occupant = slots[target] ?? null;
  slots[target] = paneId;
  if (from >= 0) slots[from] = occupant;
  // ドラッグしたペインが current なら移動先へ追従する。current のスロットの中身が
  // 変わったなら、その新しいペインを current にする。
  const currentSlot = currentSlotIndex(view);
  const current = view.current === paneId ? paneId : target === currentSlot ? paneId : view.current;
  return { openTabs: view.openTabs, current, slots };
}

// 追加帯へ落とす。末尾にスロットを 1 つ足すだけで、current は変えない。
export function addToSlots(view: SplitView, paneId: string): SplitView {
  if (view.slots.length >= MAX_SLOTS) return view;
  if (view.slots.includes(paneId)) return view;
  return { openTabs: view.openTabs, current: view.current, slots: [...view.slots, paneId] };
}

// 空きスロットを閉じる。確認は要らない（ペインの close ではない）。残りを詰める。
export function closeEmptySlot(view: SplitView, index: number): SplitView {
  if (index < 0 || index >= view.slots.length) return view;
  if (view.slots[index] !== null) return view;
  return {
    openTabs: view.openTabs,
    current: view.current,
    slots: view.slots.filter((_, at) => at !== index),
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

// スナップショットに合わせる。消えたペインはタブとスロットから落とすが、current の ID は
// 保持する（ADR 0021）。消えた current が戻ってきたらタブの右端に積み、スロットへ入れる。
export function syncSplitView(view: SplitView, exists: (paneId: string) => boolean): SplitView {
  const openTabs = view.openTabs.filter(exists);
  const slots = view.slots.map((id) => (id !== null && exists(id) ? id : null));
  const current = view.current;
  if (current === null || !exists(current)) return { openTabs, current, slots };
  const withTab = openTabs.includes(current) ? openTabs : [...openTabs, current];
  const withSlot = slots.includes(current) ? slots : placeInSlots(slots, current);
  return { openTabs: withTab, current, slots: withSlot };
}

// 保存値の正規化。壊れた値は空として扱い、実在しないペインと重複を落とす。
export function normalizeSplitView(
  view: SplitView,
  exists: (paneId: string) => boolean,
): SplitView {
  const openTabs = uniqueIds(view.openTabs).filter(exists);
  const seen = new Set<string>();
  const slots = view.slots.slice(0, MAX_SLOTS).map((id) => {
    if (id === null || !exists(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
  for (const id of slots) {
    if (id !== null && !openTabs.includes(id)) openTabs.push(id);
  }
  const current = view.current !== null && exists(view.current) ? view.current : null;
  if (current !== null && !openTabs.includes(current)) openTabs.push(current);
  let placed = slots;
  if (current !== null && !placed.includes(current)) placed = placeInSlots(placed, current);
  if (current !== null && placed.length === 0) placed = [current];
  return { openTabs, current, slots: placed };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseSplitView(value: string | null): SplitView {
  if (value === null) return EMPTY_SPLIT_VIEW;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return EMPTY_SPLIT_VIEW;
  }
  if (parsed === null || typeof parsed !== "object") return EMPTY_SPLIT_VIEW;
  const record = parsed as Record<string, unknown>;
  const openTabs = Array.isArray(record.openTabs) ? record.openTabs.filter(isString) : [];
  const slots = Array.isArray(record.slots)
    ? record.slots
        .filter((item): item is string | null => item === null || typeof item === "string")
        .slice(0, MAX_SLOTS)
    : [];
  const current = typeof record.current === "string" ? record.current : null;
  return { openTabs, current, slots };
}

export function serializeSplitView(view: SplitView): string {
  return JSON.stringify({
    openTabs: view.openTabs,
    current: view.current,
    slots: view.slots,
  });
}
