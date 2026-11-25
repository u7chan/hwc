import type { FileTreeEntry, FileTreeListing } from "../shared/file-tree";
import { readFileTree } from "./requests/panes";

// ツリーの開閉・展開・取得済みの子。PaneDetail はペイン切り替えやプレビューで
// アンマウントされるので、コンポーネントの寿命から切り離す。正はこの store だけにし、
// 表示側は購読して描く（添付チップと同じ扱い）。
// ツリーを閉じたら一覧の状態は捨てる。開き直しがそのまま取り直しになる。
// 選択中のファイルは一覧とは別に保ち、ツリーを閉じてもプレビューを残す。

export type FileTreeView = {
  open: boolean;
  // 展開しているディレクトリ。根は常に開いているので含めない（"" は常に取得する）。
  expanded: ReadonlySet<string>;
  // 取得済みのディレクトリ。キーは ""（根）と根からの相対パス。
  dirs: ReadonlyMap<string, FileTreeListing>;
  loading: ReadonlySet<string>;
  failed: ReadonlySet<string>;
  // 行のメニュー。アプリ全体で 1 つだけ持ち、分割セルでも同時に開かない。
  menu: FileTreeRowMenu | null;
};

// 行から開くメニュー 1 つ分。フォルダとファイルで項目が変わる（新しいスペースはフォルダだけ）。
export type FileTreeRowMenu = {
  path: string;
  name: string;
  kind: FileTreeEntry["kind"];
  // コピーする文字列。開いた時点の根で組み立てて固定する。根が変わってから一覧が
  // 捨てられるまでの 1 フレームで、古い行と新しい根を結合しない。
  copyTarget: string;
  // 位置合わせに使う行のボタン。行が作り直されたら開き直す。
  trigger: HTMLElement;
  // 閉じる合図のあとも、フェードアウトの間は面を残す。
  open: boolean;
};

const CLOSED: FileTreeView = {
  open: false,
  expanded: new Set(),
  dirs: new Map(),
  loading: new Set(),
  failed: new Set(),
  menu: null,
};

export type FileTreeReader = (
  paneId: string,
  path: string,
  signal: AbortSignal,
) => Promise<FileTreeListing | null>;

export type FileTreeStore = {
  view: (paneId: string) => FileTreeView;
  subscribe: (paneId: string, listener: () => void) => () => void;
  open: (paneId: string) => void;
  close: (paneId: string) => void;
  toggle: (paneId: string, path: string) => void;
  retry: (paneId: string, path: string) => void;
  // アンマウント後に開き直したとき、取得できていないディレクトリを取り直す。
  ensure: (paneId: string) => void;
  // スペースの根が変わったら、取得済みの一覧と選択中のファイルを捨てる。
  syncRoot: (paneId: string, root: string | null) => void;
  // プレビュー中のファイル（根からの相対パス）。ツリーの開閉とは独立して持つ。
  preview: (paneId: string) => string | null;
  selectFile: (paneId: string, path: string) => void;
  clearPreview: (paneId: string) => void;
  // 行のメニュー。開くときに他のペインのメニューを捨て、常に 1 つに保つ。
  openRowMenu: (paneId: string, menu: Omit<FileTreeRowMenu, "open">) => void;
  // 閉じる合図。フェードアウトが終わったら clearRowMenu で捨てる。
  closeRowMenu: (paneId: string, path: string) => void;
  // 開いているメニューを捨てる。path を渡すとそのメニューのときだけ。渡さないときは
  // 行のボタンごと消える（ツリーを閉じた・セルが外れた）合図で、使えなくなった面を残さない。
  clearRowMenu: (paneId: string, path?: string) => void;
  prune: (isAlive: (paneId: string) => boolean) => void;
};

type PaneTree = {
  view: FileTreeView;
  controller: AbortController;
};

export function createFileTreeStore(read: FileTreeReader): FileTreeStore {
  const panes = new Map<string, PaneTree>();
  const previews = new Map<string, string>();
  // ペインがどの根の一覧を持っているか。根が変わると相対パスの意味が変わる。
  const roots = new Map<string, string | null>();
  // 購読はペインごと。表示中のセルだけが購読するので、他のペインの変更を配り直さない。
  const listeners = new Map<string, Set<() => void>>();

  const notify = (paneId: string) => {
    for (const listener of new Set(listeners.get(paneId) ?? [])) listener();
  };

  const view = (paneId: string): FileTreeView => panes.get(paneId)?.view ?? CLOSED;

  const subscribe = (paneId: string, listener: () => void) => {
    const set = listeners.get(paneId) ?? new Set<() => void>();
    set.add(listener);
    listeners.set(paneId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(paneId);
    };
  };

  const update = (paneId: string, next: (current: FileTreeView) => FileTreeView) => {
    const pane = panes.get(paneId);
    if (pane === undefined) return;
    pane.view = next(pane.view);
    notify(paneId);
  };

  const load = (paneId: string, path: string) => {
    const pane = panes.get(paneId);
    if (pane === undefined || !pane.view.open) return;
    if (pane.view.dirs.has(path) || pane.view.loading.has(path) || pane.view.failed.has(path))
      return;

    const signal = pane.controller.signal;
    update(paneId, (current) => ({ ...current, loading: new Set(current.loading).add(path) }));
    void read(paneId, path, signal).then((listing) => {
      // 閉じて開き直した後・ペインが消えた後に届いた結果は捨てる。
      if (signal.aborted || panes.get(paneId) !== pane) return;
      update(paneId, (current) => {
        const loading = new Set(current.loading);
        loading.delete(path);
        if (listing === null) {
          return { ...current, loading, failed: new Set(current.failed).add(path) };
        }
        return { ...current, loading, dirs: new Map(current.dirs).set(path, listing) };
      });
    });
  };

  const ensure = (paneId: string) => {
    const pane = panes.get(paneId);
    if (pane === undefined || !pane.view.open) return;
    load(paneId, "");
    for (const path of pane.view.expanded) load(paneId, path);
  };

  // 根が変わると、取得済みの相対パスは別の場所を指す。開いているツリーは新しい根で
  // 取り直し、選択中のファイルも閉じる。
  const syncRoot = (paneId: string, root: string | null) => {
    // 初回は、その根で開かれている（または開かれようとしている）だけ。捨てるものは無い。
    if (!roots.has(paneId)) {
      roots.set(paneId, root);
      return;
    }
    if (roots.get(paneId) === root) return;
    roots.set(paneId, root);

    const pane = panes.get(paneId);
    const hadPreview = previews.delete(paneId);
    if (pane === undefined) {
      if (hadPreview) notify(paneId);
      return;
    }
    pane.controller.abort();
    panes.set(paneId, {
      view: { ...CLOSED, open: pane.view.open, expanded: new Set(), dirs: new Map() },
      controller: new AbortController(),
    });
    notify(paneId);
    ensure(paneId);
  };

  const open = (paneId: string) => {
    if (panes.get(paneId)?.view.open === true) return;
    panes.get(paneId)?.controller.abort();
    panes.set(paneId, {
      view: { ...CLOSED, open: true, expanded: new Set(), dirs: new Map() },
      controller: new AbortController(),
    });
    notify(paneId);
    ensure(paneId);
  };

  const close = (paneId: string) => {
    const pane = panes.get(paneId);
    if (pane === undefined) return;
    pane.controller.abort();
    panes.delete(paneId);
    notify(paneId);
  };

  const toggle = (paneId: string, path: string) => {
    const pane = panes.get(paneId);
    if (pane === undefined || !pane.view.open) return;
    const expanded = new Set(pane.view.expanded);
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    update(paneId, (current) => ({ ...current, expanded }));
    ensure(paneId);
  };

  const retry = (paneId: string, path: string) => {
    const pane = panes.get(paneId);
    if (pane === undefined || !pane.view.open || !pane.view.failed.has(path)) return;
    const failed = new Set(pane.view.failed);
    failed.delete(path);
    update(paneId, (current) => ({ ...current, failed }));
    load(paneId, path);
  };

  const preview = (paneId: string): string | null => previews.get(paneId) ?? null;

  const selectFile = (paneId: string, path: string) => {
    if (previews.get(paneId) === path) return;
    previews.set(paneId, path);
    notify(paneId);
  };

  const clearPreview = (paneId: string) => {
    if (!previews.delete(paneId)) return;
    notify(paneId);
  };

  // 分割セルがそれぞれメニューを持つと、同じ id の面が 2 つ描かれ、外側を 1 回押しても
  // 片方だけが閉じる。開ける場所は 1 つに限る。
  const openRowMenu = (paneId: string, menu: Omit<FileTreeRowMenu, "open">) => {
    for (const id of panes.keys()) {
      if (id === paneId || panes.get(id)?.view.menu === null) continue;
      update(id, (current) => ({ ...current, menu: null }));
    }
    update(paneId, (current) => ({ ...current, menu: { ...menu, open: true } }));
  };

  const closeRowMenu = (paneId: string, path: string) => {
    update(paneId, (current) =>
      current.menu?.path === path && current.menu.open
        ? { ...current, menu: { ...current.menu, open: false } }
        : current,
    );
  };

  const clearRowMenu = (paneId: string, path?: string) => {
    update(paneId, (current) => {
      if (current.menu === null) return current;
      if (path === undefined) return { ...current, menu: null };
      return current.menu.path === path && !current.menu.open
        ? { ...current, menu: null }
        : current;
    });
  };

  const prune = (isAlive: (paneId: string) => boolean) => {
    // Map の反復中に現在の要素を消しても、次へ進む。
    for (const paneId of panes.keys()) {
      if (isAlive(paneId)) continue;
      close(paneId);
    }
    for (const paneId of previews.keys()) {
      if (!isAlive(paneId)) previews.delete(paneId);
    }
    for (const paneId of roots.keys()) {
      if (!isAlive(paneId)) roots.delete(paneId);
    }
  };

  return {
    view,
    subscribe,
    open,
    close,
    toggle,
    retry,
    ensure,
    syncRoot,
    preview,
    selectFile,
    clearPreview,
    openRowMenu,
    closeRowMenu,
    clearRowMenu,
    prune,
  };
}

// アプリ全体で 1 つ。ペインを切り替えても同じ store を読む。
export const fileTreeStore = createFileTreeStore(readFileTree);
