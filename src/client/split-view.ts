// 分割ビューの状態。セル（葉）ごとのタブと選択（active）、フォーカス中のペイン（current）、
// 方向つきの二分木（layout）だけを持ち、Herdr の状態は持たない。
export const MAX_LEAVES = 4;

export type SplitDir = "row" | "col";

export type SplitLeaf = {
  kind: "leaf";
  // セルの識別子。タブの追加・削除・active の変更では変えない。セルの key と
  // FLIP の照合に使い、タブを外したときの再マウントを防ぐ。
  id: string;
  // そのセルのタブ。1 枚以上、木全体で重複しない。
  tabs: readonly string[];
  // 選択中のタブ。tabs のどれか。
  active: string;
};

export type SplitNode = SplitLeaf | { kind: "split"; dir: SplitDir; children: SplitNode[] };

export type DropZone = "center" | "top" | "bottom" | "left" | "right";

// タブ列への差し込み位置。対象タブの左半分なら前、右半分なら後ろ。
export type TabSide = "before" | "after";

export type SplitView = {
  // フォーカス中のセルの active。実在しないペインの ID と null を許す。
  current: string | null;
  // 葉が最大 4 つ。空の葉は持たない。同じ向きのネストは作らない。
  layout: SplitNode | null;
};

export const EMPTY_SPLIT_VIEW: SplitView = { current: null, layout: null };

// 再読み込みを跨いでも衝突しないよう、モジュールごとの乱数接頭辞を付ける。
// 同じセッション内では連番。保存値の id は parse / normalize がそのまま使う。
const LEAF_ID_PREFIX = Math.random().toString(36).slice(2, 10);
let leafIdSeq = 0;

function newLeafId(): string {
  leafIdSeq += 1;
  return `leaf-${LEAF_ID_PREFIX}-${leafIdSeq}`;
}

function makeLeaf(tabs: readonly string[], active?: string, id = newLeafId()): SplitLeaf {
  const first = tabs[0];
  if (first === undefined) throw new Error("a leaf needs at least one tab");
  return {
    kind: "leaf",
    id,
    tabs,
    active: active !== undefined && tabs.includes(active) ? active : first,
  };
}

// 保存も再読み込みもしない、初回表示の状態。開いていたペインが無ければ一覧から始める。
export function startSplitView(paneId: string | null): SplitView {
  return paneId === null ? EMPTY_SPLIT_VIEW : { current: paneId, layout: makeLeaf([paneId]) };
}

// 木の葉を、木の構造順（深さ優先）で返す。正規化と畳み込みに使う。
export function treeLeaves(node: SplitNode | null): SplitLeaf[] {
  if (node === null) return [];
  if (node.kind === "leaf") return [node];
  return node.children.flatMap(treeLeaves);
}

// 木のタブを構造順に返す。
export function treeTabs(node: SplitNode | null): string[] {
  return treeLeaves(node).flatMap((leaf) => leaf.tabs);
}

// 各葉の画面上の位置。行と列の分割は等分なので、比率だけで並べ替えられる。
type LeafBox = { leaf: SplitLeaf; top: number; left: number };

function collectLeafBoxes(
  node: SplitNode,
  left: number,
  top: number,
  width: number,
  height: number,
  out: LeafBox[],
): void {
  if (node.kind === "leaf") {
    out.push({ leaf: node, top, left });
    return;
  }
  const count = node.children.length;
  for (let index = 0; index < count; index += 1) {
    const child = node.children[index];
    if (child === undefined) continue;
    if (node.dir === "row") {
      collectLeafBoxes(child, left + (width * index) / count, top, width / count, height, out);
    } else {
      collectLeafBoxes(child, left, top + (height * index) / count, width, height / count, out);
    }
  }
}

// 画面の読み順（上端→左端）。2x2 は左上→右上→左下→右下、T 字は左上→右上→左下。
// 木の深さ優先（左上→左下→右上→右下）とは 3 枚以上で変わる。
export function readingOrder(node: SplitNode | null): SplitLeaf[] {
  if (node === null) return [];
  const boxes: LeafBox[] = [];
  collectLeafBoxes(node, 0, 0, 1, 1, boxes);
  // 2 分岐の座標は 2 進小数で厳密に一致する。3 子以上が残った保存値でも
  // 同じ行の判定が揺れないよう、差は許容誤差で見る。
  const epsilon = 1e-9;
  boxes.sort((a, b) => {
    if (Math.abs(a.top - b.top) > epsilon) return a.top - b.top;
    return a.left - b.left;
  });
  return boxes.map((box) => box.leaf);
}

// 開いているタブ。読み順に葉を並べ、各葉のタブを連結する。状態には持たない。
export function openTabs(view: SplitView): string[] {
  return readingOrder(view.layout).flatMap((leaf) => leaf.tabs);
}

// 各セルが表示しているペイン。プロセスの取得対象に使う。
export function activePanes(view: SplitView): string[] {
  return readingOrder(view.layout).map((leaf) => leaf.active);
}

export function leafOfPane(node: SplitNode | null, paneId: string): SplitLeaf | null {
  if (node === null) return null;
  if (node.kind === "leaf") return node.tabs.includes(paneId) ? node : null;
  for (const child of node.children) {
    const found = leafOfPane(child, paneId);
    if (found !== null) return found;
  }
  return null;
}

// フォーカス中の葉。current が葉に無ければ先頭の葉。木が空なら null。
export function focusedLeaf(view: SplitView): SplitLeaf | null {
  return leafOfPane(view.layout, view.current ?? "") ?? readingOrder(view.layout)[0] ?? null;
}

export function multiSpace(workspaceIds: readonly string[]): boolean {
  return new Set(workspaceIds).size > 1;
}

// 同じ軸に並ぶ葉を、子 2 つの木へ組み直す。3 枚は T 字、4 枚は 2x2。
// 保存値の正規化と、葉を除去したときの畳みで使う。
function buildSupported(dir: SplitDir, leaves: readonly SplitLeaf[]): SplitNode | null {
  const [a, b, c, d] = leaves.slice(0, MAX_LEAVES);
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
  return buildSupported(node.dir, children.flatMap(treeLeaves));
}

// 特定の葉だけを差し替える。葉は木の中の実体で照合する。
function updateLeaf(
  node: SplitNode,
  target: SplitLeaf,
  update: (leaf: SplitLeaf) => SplitLeaf | null,
): SplitNode | null {
  if (node.kind === "leaf") return node === target ? update(node) : node;
  const children = node.children
    .map((child) => updateLeaf(child, target, update))
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return { kind: "split", dir: node.dir, children };
}

function replaceLeaf(node: SplitNode, target: SplitLeaf, next: SplitLeaf): SplitNode {
  return updateLeaf(node, target, () => next) ?? node;
}

function removeLeaf(layout: SplitNode, leaf: SplitLeaf): SplitNode | null {
  return compactLayout(updateLeaf(layout, leaf, () => null));
}

function splitLeaf(
  node: SplitNode,
  target: string,
  dir: SplitDir,
  before: boolean,
  inserted: SplitLeaf,
): SplitNode {
  if (node.kind === "leaf") {
    if (!node.tabs.includes(target)) return node;
    const children = before ? [inserted, node] : [node, inserted];
    return { kind: "split", dir, children };
  }
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((child) => splitLeaf(child, target, dir, before, inserted)),
  };
}

// そのタブの葉の親の分割軸。親が無ければ null。
function parentDirOf(
  node: SplitNode | null,
  paneId: string,
  dir: SplitDir | null = null,
): SplitDir | null {
  if (node === null) return null;
  if (node.kind === "leaf") return node.tabs.includes(paneId) ? dir : null;
  for (const child of node.children) {
    if (child.kind === "leaf") {
      if (child.tabs.includes(paneId)) return node.dir;
    } else {
      const found = parentDirOf(child, paneId, node.dir);
      if (found !== null) return found;
    }
  }
  return null;
}

function zoneDir(zone: Exclude<DropZone, "center">): SplitDir {
  return zone === "top" || zone === "bottom" ? "col" : "row";
}

// 葉からタブを外す。active を外したら同じ葉の次（末尾なら手前）へ移す。
// 空になった葉は畳む。
function removeTabFromLeaf(layout: SplitNode, leaf: SplitLeaf, paneId: string): SplitNode | null {
  const at = leaf.tabs.indexOf(paneId);
  if (at < 0) return layout;
  const tabs = leaf.tabs.filter((id) => id !== paneId);
  if (tabs.length === 0) return removeLeaf(layout, leaf);
  const active = leaf.active === paneId ? (tabs[at] ?? tabs[at - 1] ?? tabs[0]) : leaf.active;
  return compactLayout(updateLeaf(layout, leaf, () => makeLeaf(tabs, active, leaf.id)));
}

type EdgePlan = { base: SplitNode; anchor: string; dir: SplitDir; before: boolean };

// 端へのドロップを受け付けるか、受け付けるならどの木へどの向きで入れるか。
// 元の葉から先に外し、空くなった葉は畳んでから、残る木で向きを見る。
function edgePlan(
  view: SplitView,
  source: string,
  target: string,
  zone: Exclude<DropZone, "center">,
): EdgePlan | null {
  const targetLeaf = leafOfPane(view.layout, target);
  if (targetLeaf === null) return null;
  const sourceLeaf = leafOfPane(view.layout, source);
  let base: SplitNode | null = view.layout;
  if (sourceLeaf !== null) {
    // 自分自身の端へ出すと元の葉が空になる場合は、残せるタブが無い。
    if (sourceLeaf === targetLeaf && sourceLeaf.tabs.length < 2) return null;
    base = removeTabFromLeaf(view.layout as SplitNode, sourceLeaf, source);
  }
  if (base === null) return null;
  // 元の葉から source を外したあとも残るタブで、分ける葉を指す。
  const anchor = targetLeaf.tabs.find((id) => id !== source);
  if (anchor === undefined || leafOfPane(base, anchor) === null) return null;
  if (readingOrder(base).length + 1 > MAX_LEAVES) return null;
  const dir = zoneDir(zone);
  if (parentDirOf(base, anchor) === dir) return null;
  return { base, anchor, dir, before: zone === "top" || zone === "left" };
}

// そのドロップを受け付けられるか。プレビューを出すかどうかもこれで決める。
// 同じ向きのネスト（3 列・3 段）と 4 枚超えは受け付けない。
export function canDrop(view: SplitView, source: string, target: string, zone: DropZone): boolean {
  if (zone === "center") return leafOfPane(view.layout, target) !== null;
  return edgePlan(view, source, target, zone) !== null;
}

// セルの中央へ落とす。その葉の末尾へ移し、active と current をそのペインにする。
function dropOnCenter(view: SplitView, source: string, target: string): SplitView {
  const targetLeaf = leafOfPane(view.layout, target);
  if (targetLeaf === null) return view;
  const sourceLeaf = leafOfPane(view.layout, source);
  if (sourceLeaf === targetLeaf) {
    const tabs = [...targetLeaf.tabs.filter((id) => id !== source), source];
    const layout = replaceLeaf(
      view.layout as SplitNode,
      targetLeaf,
      makeLeaf(tabs, source, targetLeaf.id),
    );
    return { current: source, layout };
  }
  let base = view.layout;
  if (sourceLeaf !== null) {
    base = removeTabFromLeaf(view.layout as SplitNode, sourceLeaf, source);
    if (base === null) return view;
  }
  if (base === null) return view;
  const host = leafOfPane(base, target);
  if (host === null) return view;
  const layout = replaceLeaf(base, host, makeLeaf([...host.tabs, source], source, host.id));
  return { current: source, layout };
}

// ドロップを適用する。中央は末尾へ移動、端はその方向への分割。
// 移動・分割のあとは、動かしたペインを選択する。
export function dropOnPane(
  view: SplitView,
  source: string,
  target: string,
  zone: DropZone,
): SplitView {
  if (zone === "center") return dropOnCenter(view, source, target);
  const plan = edgePlan(view, source, target, zone);
  if (plan === null) return view;
  const layout = splitLeaf(plan.base, plan.anchor, plan.dir, plan.before, makeLeaf([source]));
  return { current: source, layout };
}

// 一覧・タブからペインを開く。すでにどこかの葉にあればその葉を active にする。
// 無ければフォーカス中の葉（無ければ最初の葉）の末尾へ足す。
export function openPane(view: SplitView, paneId: string): SplitView {
  const leaf = leafOfPane(view.layout, paneId);
  if (leaf !== null) {
    if (view.current === paneId && leaf.active === paneId) return view;
    return {
      current: paneId,
      layout: replaceLeaf(view.layout as SplitNode, leaf, makeLeaf(leaf.tabs, paneId, leaf.id)),
    };
  }
  const target = focusedLeaf(view);
  if (target === null) return { current: paneId, layout: makeLeaf([paneId]) };
  const layout = replaceLeaf(
    view.layout as SplitNode,
    target,
    makeLeaf([...target.tabs, paneId], paneId, target.id),
  );
  return { current: paneId, layout };
}

// タブを別の位置へ移す。同じ葉の中のタブの上なら並べ替えだけで、active と current は
// 動かさない。タブ列の隙間（select）・別の葉・一覧からなら、移した先の active と
// current をそのペインにする。
export function moveTab(
  view: SplitView,
  source: string,
  target: string,
  side: TabSide,
  select = false,
): SplitView {
  if (source === target) {
    if (!select) return view;
    const leaf = leafOfPane(view.layout, source);
    if (leaf === null) return view;
    return {
      current: source,
      layout: replaceLeaf(view.layout as SplitNode, leaf, makeLeaf(leaf.tabs, source, leaf.id)),
    };
  }
  const targetLeaf = leafOfPane(view.layout, target);
  if (targetLeaf === null) return view;
  const sourceLeaf = leafOfPane(view.layout, source);
  if (sourceLeaf === targetLeaf) {
    const rest = targetLeaf.tabs.filter((id) => id !== source);
    const at = rest.indexOf(target);
    if (at < 0) return view;
    const cut = side === "before" ? at : at + 1;
    const tabs = [...rest.slice(0, cut), source, ...rest.slice(cut)];
    const same = tabs.every((id, index) => id === targetLeaf.tabs[index]);
    if (same && !select) return view;
    return {
      current: select ? source : view.current,
      layout: replaceLeaf(
        view.layout as SplitNode,
        targetLeaf,
        makeLeaf(tabs, select ? source : targetLeaf.active, targetLeaf.id),
      ),
    };
  }
  let base = view.layout;
  if (sourceLeaf !== null) {
    base = removeTabFromLeaf(view.layout as SplitNode, sourceLeaf, source);
    if (base === null) return view;
  }
  if (base === null) return view;
  const host = leafOfPane(base, target);
  if (host === null) return view;
  const at = host.tabs.indexOf(target);
  const cut = side === "before" ? at : at + 1;
  const tabs = [...host.tabs.slice(0, cut), source, ...host.tabs.slice(cut)];
  return {
    current: source,
    layout: replaceLeaf(base, host, makeLeaf(tabs, source, host.id)),
  };
}

// 外から現れたペインを、指定の葉へ差し込む。空きがあれば端へ分割し、埋まっていれば
// その葉のタブとして足す。委譲では利用者が選んでいないので、current は動かさない。
// 分割の向きは、同じ向きのネストを作らない最初のもの（右 → 下 → 左 → 上）にする。
const DELEGATION_EDGES: readonly Exclude<DropZone, "center">[] = ["right", "bottom", "left", "top"];

export function insertDelegatedPane(
  view: SplitView,
  paneId: string,
  targetPane: string,
): SplitView {
  if (leafOfPane(view.layout, paneId) !== null) return view;
  const target = leafOfPane(view.layout, targetPane);
  if (target === null) return view;
  if (readingOrder(view.layout).length < MAX_LEAVES) {
    for (const zone of DELEGATION_EDGES) {
      if (!canDrop(view, paneId, targetPane, zone)) continue;
      const next = dropOnPane(view, paneId, targetPane, zone);
      if (next !== view) return { current: view.current, layout: next.layout };
    }
  }
  const layout = replaceLeaf(
    view.layout as SplitNode,
    target,
    makeLeaf([...target.tabs, paneId], target.active, target.id),
  );
  return { current: view.current, layout };
}

// 一覧へ戻す。木とタブは残す。
export function clearCurrent(view: SplitView): SplitView {
  return { ...view, current: null };
}

// 同じ葉の次（末尾なら手前）のタブ。閉じる確認の後継に使う。
export function successorTab(view: SplitView, paneId: string): string | null {
  const leaf = leafOfPane(view.layout, paneId);
  if (leaf === null) return null;
  const at = leaf.tabs.indexOf(paneId);
  return leaf.tabs[at + 1] ?? leaf.tabs[at - 1] ?? null;
}

// タブから外す。ペインは閉じない。空になった葉は畳み、current を外したときだけ
// 選択を後継へ動かす。後継は同じ葉、葉が消えたら読み順の次（無ければ null）。
export function removeTab(view: SplitView, paneId: string, successor?: string | null): SplitView {
  const leaf = leafOfPane(view.layout, paneId);
  if (leaf === null) return view;
  const order = readingOrder(view.layout);
  const at = leaf.tabs.indexOf(paneId);
  const tabs = leaf.tabs.filter((id) => id !== paneId);
  // 閉じる確認で決めた同じ葉の後継があれば、それを使う。並びが変わっていても
  // 実在するタブだけを採る。
  const preferred =
    successor != null && successor !== paneId && tabs.includes(successor) ? successor : null;
  const active =
    leaf.active === paneId ? (preferred ?? tabs[at] ?? tabs[at - 1] ?? tabs[0] ?? "") : leaf.active;
  const layout =
    tabs.length === 0
      ? removeLeaf(view.layout as SplitNode, leaf)
      : updateLeaf(view.layout as SplitNode, leaf, () => makeLeaf(tabs, active, leaf.id));
  if (view.current !== paneId) return { current: view.current, layout };
  if (tabs.length > 0) return { current: active, layout };
  const atLeaf = order.indexOf(leaf);
  const nextLeaf = order.slice(atLeaf + 1).find((item) => item !== leaf);
  return { current: nextLeaf?.active ?? null, layout };
}

// スナップショットに合わせる。消えたペインはタブから落とし、空の葉は畳む。
// current の ID は保持し、実在するのに木へ無ければ最初の葉へ足す。
// 不変条件（葉 1〜4・重複なし・active ∈ tabs・current と active の一致）を強制する。
export function syncSplitView(view: SplitView, exists: (paneId: string) => boolean): SplitView {
  return normalizeSplitView(view, exists);
}

// 保存値の正規化。存在しないペインと重複・余分な葉を落とし、active が消えたら
// 同じ葉の次へ移す。current は実在しなければ ID を保持し、実在して木に無ければ
// 最初の葉へ足して active にする。
export function normalizeSplitView(
  view: SplitView,
  exists: (paneId: string) => boolean,
): SplitView {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const count = { leaves: 0 };
  const layout = compactLayout(normalizeNode(view.layout, exists, seen, ids, count));
  return enforceCurrent(layout, view.current, exists);
}

function normalizeNode(
  node: SplitNode | null,
  exists: (paneId: string) => boolean,
  seen: Set<string>,
  ids: Set<string>,
  count: { leaves: number },
): SplitNode | null {
  if (node === null) return null;
  if (node.kind === "leaf") {
    if (count.leaves >= MAX_LEAVES) return null;
    const kept: { id: string; at: number }[] = [];
    for (let index = 0; index < node.tabs.length; index += 1) {
      const id = node.tabs[index];
      if (id === undefined || !exists(id) || seen.has(id)) continue;
      kept.push({ id, at: index });
    }
    if (kept.length === 0) return null;
    let active = node.active;
    if (!kept.some((item) => item.id === active)) {
      const activeAt = node.tabs.indexOf(node.active);
      const next = kept.find((item) => item.at > activeAt);
      active = (next ?? kept[kept.length - 1])?.id ?? kept[0]?.id ?? active;
    }
    // id が無い・空・重複の保存値には新しい id を割り当てる。タブを落としても
    // 残った葉の id は変えない。
    const id = node.id !== "" && !ids.has(node.id) ? node.id : newLeafId();
    ids.add(id);
    for (const item of kept) seen.add(item.id);
    count.leaves += 1;
    return { kind: "leaf", id, tabs: kept.map((item) => item.id), active };
  }
  const children = node.children
    .map((child) => normalizeNode(child, exists, seen, ids, count))
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return { kind: "split", dir: node.dir, children };
}

// current が実在するなら、木にある葉の active と一致させる。木に無ければ最初の葉へ足す。
function enforceCurrent(
  layout: SplitNode | null,
  current: string | null,
  exists: (paneId: string) => boolean,
): SplitView {
  if (current === null || !exists(current)) return { current, layout };
  const at = leafOfPane(layout, current);
  if (at !== null && at.active === current) return { current, layout };
  if (at !== null && layout !== null) {
    return { current, layout: replaceLeaf(layout, at, makeLeaf(at.tabs, current, at.id)) };
  }
  const first = readingOrder(layout)[0];
  if (first === undefined) return { current, layout: makeLeaf([current]) };
  return {
    current,
    layout: replaceLeaf(
      layout as SplitNode,
      first,
      makeLeaf([...first.tabs, current], current, first.id),
    ),
  };
}

// 保存も再読み込みもしない、木の形とタブの並びのキー。active の変更では変えない。
export function layoutKey(node: SplitNode | null): string {
  return JSON.stringify(shapeOf(node));
}

function shapeOf(node: SplitNode | null): unknown {
  if (node === null) return null;
  if (node.kind === "leaf") return { id: node.id, tabs: node.tabs };
  return { dir: node.dir, children: node.children.map(shapeOf) };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseNode(value: unknown): SplitNode | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "leaf") {
    if (!Array.isArray(record.tabs) || !isString(record.active)) return null;
    const tabs = record.tabs.filter(isString);
    const first = tabs[0];
    if (first === undefined) return null;
    return {
      kind: "leaf",
      id: isString(record.id) && record.id !== "" ? record.id : newLeafId(),
      tabs,
      active: tabs.includes(record.active) ? record.active : first,
    };
  }
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

// 読めない木は空にし、current だけを残す。木が壊れていても、開いていたペインは失わない。
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
  const current = isString(record.current) ? record.current : null;
  const layout = parseNode(record.layout);
  return { current, layout };
}

export function serializeSplitView(view: SplitView): string {
  return JSON.stringify({ current: view.current, layout: view.layout });
}

// 掴んでからドラッグを始める移動量。クリックとの競合を移動量で分ける。
export const PANE_DRAG_THRESHOLD = 6;

// 掴んだ位置からの移動がドラッグの開始に足るか。一覧の行は縦にスクロールするので、
// 触れる画面ではセルの方（右）へ向かう横の動きだけを開始とみなす。マウスは向きを
// 問わない。一覧以外（タブ・セルの見出し）は縦の移動でも開始できる。
export function startsPaneDrag(
  pointerType: string,
  fromList: boolean,
  dx: number,
  dy: number,
): boolean {
  if (Math.abs(dx) < PANE_DRAG_THRESHOLD && Math.abs(dy) < PANE_DRAG_THRESHOLD) return false;
  if (!fromList || pointerType === "mouse") return true;
  return dx > 0 && Math.abs(dx) > Math.abs(dy);
}
