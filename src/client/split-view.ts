// 分割ビューの状態。開いたペインの履歴（openTabs）、選択（current）、方向つきの
// 二分木（layout）だけを持ち、Herdr の状態は持たない（ADR 0061）。
export const MAX_LEAVES = 4;

export type SplitDir = "row" | "col";

export type SplitNode =
  | { kind: "leaf"; pane: string }
  | { kind: "split"; dir: SplitDir; children: SplitNode[] };

export type DropZone = "center" | "top" | "bottom" | "left" | "right";

export type SplitView = {
  // 開いた順。全スペースを跨ぎ、一意で、実在するペインだけ。
  openTabs: readonly string[];
  // 選択中のペイン。消えたペインの ID を保持することがある（ADR 0021）。
  current: string | null;
  // 葉が最大 4 つ。空きの葉は持たない。同じ向きのネストは作らない（ADR 0061）。
  layout: SplitNode | null;
};

export const EMPTY_SPLIT_VIEW: SplitView = { openTabs: [], current: null, layout: null };

// 保存も再読み込みもしない、初回表示の状態。開いていたペインが無ければ一覧から始める。
export function startSplitView(paneId: string | null): SplitView {
  return paneId === null
    ? EMPTY_SPLIT_VIEW
    : { openTabs: [paneId], current: paneId, layout: { kind: "leaf", pane: paneId } };
}

// 木の葉を、左上から右下の順（深さ優先）で返す。スロット色の位置はこの順で決まる。
export function leafPanes(node: SplitNode | null): string[] {
  if (node === null) return [];
  if (node.kind === "leaf") return [node.pane];
  return node.children.flatMap(leafPanes);
}

export function slotIndexOf(view: SplitView, paneId: string): number {
  return leafPanes(view.layout).indexOf(paneId);
}

export function currentSlotIndex(view: SplitView): number {
  return view.current === null ? -1 : slotIndexOf(view, view.current);
}

export function multiSpace(workspaceIds: readonly string[]): boolean {
  return new Set(workspaceIds).size > 1;
}

// 同じ軸に並ぶ葉を、子 2 つの木へ組み直す。3 枚は T 字、4 枚は 2x2。
// 保存値の正規化と、葉を除去したときの畳みで使う（ADR 0061）。
function buildSupported(dir: SplitDir, panes: readonly string[]): SplitNode | null {
  const leaves: SplitNode[] = panes.slice(0, MAX_LEAVES).map((pane) => ({ kind: "leaf", pane }));
  const [a, b, c, d] = leaves;
  if (a === undefined) return null;
  if (b === undefined) return a;
  const cross: SplitDir = dir === "row" ? "col" : "row";
  if (c === undefined) return { kind: "split", dir, children: [a, b] };
  if (d === undefined) {
    return {
      kind: "split",
      dir,
      children: [{ kind: "split", dir: cross, children: [a, b] }, c],
    };
  }
  return {
    kind: "split",
    dir,
    children: [
      { kind: "split", dir: cross, children: [a, b] },
      { kind: "split", dir: cross, children: [c, d] },
    ],
  };
}

// 子が 1 つになった split を畳み、同じ向きの入れ子は 2 つずつに組み直す。
function compactLayout(node: SplitNode | null): SplitNode | null {
  if (node === null || node.kind === "leaf") return node;
  const children = node.children
    .map(compactLayout)
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  const nested = children.some((child) => child.kind === "split" && child.dir === node.dir);
  if (children.length === 2 && !nested) return { kind: "split", dir: node.dir, children };
  return buildSupported(node.dir, children.flatMap(leafPanes));
}

function withoutLeaf(node: SplitNode | null, paneId: string): SplitNode | null {
  return compactLayout(removeNode(node, paneId));
}

function removeNode(node: SplitNode | null, paneId: string): SplitNode | null {
  if (node === null) return null;
  if (node.kind === "leaf") return node.pane === paneId ? null : node;
  const children = node.children
    .map((child) => removeNode(child, paneId))
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return { kind: "split", dir: node.dir, children };
}

// その葉の親の分割軸。親が無ければ null。
function parentDirOf(
  node: SplitNode | null,
  paneId: string,
  dir: SplitDir | null = null,
): SplitDir | null {
  if (node === null) return null;
  if (node.kind === "leaf") return node.pane === paneId ? dir : null;
  for (const child of node.children) {
    if (child.kind === "leaf" && child.pane === paneId) return node.dir;
    const found = parentDirOf(child, paneId, node.dir);
    if (found !== null) return found;
  }
  return null;
}

function replaceLeaf(node: SplitNode | null, target: string, paneId: string): SplitNode | null {
  if (node === null) return null;
  if (node.kind === "leaf") return node.pane === target ? { kind: "leaf", pane: paneId } : node;
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((child) => replaceLeaf(child, target, paneId) ?? child),
  };
}

function splitLeaf(
  node: SplitNode | null,
  target: string,
  dir: SplitDir,
  before: boolean,
  paneId: string,
): SplitNode | null {
  if (node === null) return null;
  if (node.kind === "leaf") {
    if (node.pane !== target) return node;
    const inserted: SplitNode = { kind: "leaf", pane: paneId };
    const children = before ? [inserted, node] : [node, inserted];
    return { kind: "split", dir, children };
  }
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((child) => splitLeaf(child, target, dir, before, paneId) ?? child),
  };
}

function swapLeaves(node: SplitNode | null, a: string, b: string): SplitNode | null {
  if (node === null) return null;
  if (node.kind === "leaf") {
    if (node.pane === a) return { kind: "leaf", pane: b };
    if (node.pane === b) return { kind: "leaf", pane: a };
    return node;
  }
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((child) => swapLeaves(child, a, b) ?? child),
  };
}

function zoneDir(zone: Exclude<DropZone, "center">): SplitDir {
  return zone === "top" || zone === "bottom" ? "col" : "row";
}

// そのドロップを受け付けられるか。プレビューを出すかどうかもこれで決める。
// 同じ向きのネスト（3 列・3 段）と 4 枚超えは受け付けない。
export function canDrop(view: SplitView, source: string, target: string, zone: DropZone): boolean {
  if (view.layout === null || source === target) return false;
  const inLayout = leafPanes(view.layout).includes(source);
  const base = inLayout ? withoutLeaf(view.layout, source) : view.layout;
  if (base === null) return false;
  const leaves = leafPanes(base);
  if (!leaves.includes(target)) return false;
  if (zone === "center") return true;
  if (leaves.length + 1 > MAX_LEAVES) return false;
  return parentDirOf(base, target) !== zoneDir(zone);
}

// ドロップを適用する。中央は入れ替え（木の外のタブなら置換）、端は分割。
// 選択は動かしたペインへ移す。
export function dropOnPane(
  view: SplitView,
  source: string,
  target: string,
  zone: DropZone,
): SplitView {
  if (!canDrop(view, source, target, zone)) return view;
  const layout = view.layout;
  if (layout === null) return view;
  const inLayout = leafPanes(layout).includes(source);
  const openTabs = view.openTabs.includes(source) ? view.openTabs : [...view.openTabs, source];
  if (zone === "center") {
    const next = inLayout
      ? swapLeaves(layout, source, target)
      : replaceLeaf(layout, target, source);
    return { openTabs, current: source, layout: next };
  }
  const base = inLayout ? withoutLeaf(layout, source) : layout;
  const next = splitLeaf(base, target, zoneDir(zone), zone === "top" || zone === "left", source);
  return { openTabs, current: source, layout: next };
}

// 一覧・タブからペインを開く。木に無ければ current の葉を置き換える。current が
// 無ければ最初の葉、木が空なら 1 枚で始める。
export function openPane(view: SplitView, paneId: string): SplitView {
  const openTabs = view.openTabs.includes(paneId) ? view.openTabs : [...view.openTabs, paneId];
  const leaves = leafPanes(view.layout);
  if (leaves.includes(paneId)) return { openTabs, current: paneId, layout: view.layout };
  const target = view.current !== null && leaves.includes(view.current) ? view.current : leaves[0];
  const layout: SplitNode | null =
    target === undefined
      ? { kind: "leaf", pane: paneId }
      : replaceLeaf(view.layout, target, paneId);
  return { openTabs, current: paneId, layout };
}

// 一覧へ戻す。開いたタブとレイアウトは残す。
export function clearCurrent(view: SplitView): SplitView {
  return { openTabs: view.openTabs, current: null, layout: view.layout };
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

// タブから外す。ペインは閉じない（Herdr 側では動き続ける）。葉を除いて親を畳み、
// current を外したときだけ選択を後継へ動かす。後継が木に無ければ最初の葉を使う。
export function removeTab(view: SplitView, paneId: string, successor?: string | null): SplitView {
  if (!view.openTabs.includes(paneId)) return view;
  const openTabs = view.openTabs.filter((id) => id !== paneId);
  const layout = withoutLeaf(view.layout, paneId);
  if (view.current !== paneId) return { openTabs, current: view.current, layout };
  const next = successor === undefined ? nextOpenPane(view.openTabs, paneId) : successor;
  const leaves = leafPanes(layout);
  const current = next !== null && leaves.includes(next) ? next : (leaves[0] ?? null);
  return { openTabs, current, layout };
}

// スナップショットに合わせる。消えたペインはタブと葉から落とし、親を畳む。current の
// ID は保持する（ADR 0021）。消えた current が戻ってきたら葉へ戻す。
export function syncSplitView(view: SplitView, exists: (paneId: string) => boolean): SplitView {
  const openTabs = view.openTabs.filter(exists);
  const layout = pruneLayout(view.layout, exists);
  const current = view.current;
  if (current === null) return { openTabs, current, layout };
  if (!exists(current)) return { openTabs, current, layout };
  const withTab = openTabs.includes(current) ? openTabs : [...openTabs, current];
  const leaves = leafPanes(layout);
  if (leaves.includes(current)) return { openTabs: withTab, current, layout };
  if (leaves.length === 0)
    return { openTabs: withTab, current, layout: { kind: "leaf", pane: current } };
  return { openTabs: withTab, current, layout: replaceLeaf(layout, leaves[0] ?? current, current) };
}

function pruneLayout(
  node: SplitNode | null,
  exists: (paneId: string) => boolean,
): SplitNode | null {
  return compactLayout(pruneNode(node, exists));
}

function pruneNode(node: SplitNode | null, exists: (paneId: string) => boolean): SplitNode | null {
  if (node === null) return null;
  if (node.kind === "leaf") return exists(node.pane) ? node : null;
  const children = node.children
    .map((child) => pruneNode(child, exists))
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return { kind: "split", dir: node.dir, children };
}

// 保存値の正規化。壊れた値は空として扱い、実在しないペインと重複を落とす。
export function normalizeSplitView(
  view: SplitView,
  exists: (paneId: string) => boolean,
): SplitView {
  const openTabs = uniqueIds(view.openTabs).filter(exists);
  const layout = normalizeLayout(view.layout, exists);
  const current = view.current !== null && exists(view.current) ? view.current : null;
  const withTab =
    current !== null && !openTabs.includes(current) ? [...openTabs, current] : openTabs;
  if (current === null) return { openTabs: withTab, current, layout };
  const leaves = leafPanes(layout);
  if (leaves.includes(current)) return { openTabs: withTab, current, layout };
  if (leaves.length === 0)
    return { openTabs: withTab, current, layout: { kind: "leaf", pane: current } };
  return { openTabs: withTab, current, layout: replaceLeaf(layout, leaves[0] ?? current, current) };
}

// 葉が重複していたら後から出た方を捨て、4 つを超えたら残りを落とす。
function normalizeLayout(
  node: SplitNode | null,
  exists: (paneId: string) => boolean,
): SplitNode | null {
  return compactLayout(normalizeNode(node, exists, new Set()));
}

function normalizeNode(
  node: SplitNode | null,
  exists: (paneId: string) => boolean,
  seen: Set<string>,
): SplitNode | null {
  if (node === null) return null;
  if (node.kind === "leaf") {
    if (!exists(node.pane) || seen.has(node.pane) || seen.size >= MAX_LEAVES) return null;
    seen.add(node.pane);
    return node;
  }
  const children = node.children
    .map((child) => normalizeNode(child, exists, seen))
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return { kind: "split", dir: node.dir, children };
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

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseNode(value: unknown): SplitNode | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "leaf")
    return isString(record.pane) ? { kind: "leaf", pane: record.pane } : null;
  if (record.kind !== "split") return null;
  const dir = record.dir === "row" || record.dir === "col" ? record.dir : null;
  if (dir === null || !Array.isArray(record.children)) return null;
  const children = record.children
    .map(parseNode)
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return compactLayout({ kind: "split", dir, children });
}

export function parseSplitView(value: string | null): SplitView {
  if (value === null) return EMPTY_SPLIT_VIEW;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return EMPTY_SPLIT_VIEW;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_SPLIT_VIEW;
  }
  const record = parsed as Record<string, unknown>;
  const openTabs = Array.isArray(record.openTabs) ? record.openTabs.filter(isString) : [];
  const current = isString(record.current) ? record.current : null;
  const layout = parseNode(record.layout);
  return { openTabs, current, layout };
}

export function serializeSplitView(view: SplitView): string {
  return JSON.stringify({
    openTabs: view.openTabs,
    current: view.current,
    layout: view.layout,
  });
}
