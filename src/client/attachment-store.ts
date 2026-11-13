// 添付チップは PaneDetail の外に置く。ペインを切り替えると PaneDetail は作り直されるが、
// 送信するまでチップを残すには、コンポーネントの寿命から切り離す必要がある。
// 正はこの store だけにし、表示側は購読して描く。
// リロードは保証しない。復元には保存名を localStorage へ残す必要があるが、
// 進行中のアップロードはどのみち復元できないので、ペイン切り替えのためだけに持つ。

export type AttachedFile = {
  key: string;
  name: string | null;
  controller: AbortController;
};

type PaneAttachments = {
  items: AttachedFile[];
  nextKey: number;
};

export type AttachmentStore = {
  items: (paneId: string) => readonly AttachedFile[];
  subscribe: (paneId: string, listener: () => void) => () => void;
  begin: (paneId: string) => { key: string; controller: AbortController };
  settle: (paneId: string, key: string, name: string) => void;
  remove: (paneId: string, key: string) => void;
  clear: (paneId: string) => void;
  prune: (isAlive: (paneId: string) => boolean) => void;
};

export function createAttachmentStore(): AttachmentStore {
  const panes = new Map<string, PaneAttachments>();
  // 購読はペインごと。表示中の 1 枚だけが購読するので、他のペインの変更を配り直さない。
  const listeners = new Map<string, Set<() => void>>();
  const empty: readonly AttachedFile[] = [];

  const notify = (paneId: string) => {
    // 通知中に購読解除されても取りこぼさないよう、コピーを回す。
    for (const listener of new Set(listeners.get(paneId) ?? [])) listener();
  };

  const items = (paneId: string): readonly AttachedFile[] => panes.get(paneId)?.items ?? empty;

  const subscribe = (paneId: string, listener: () => void) => {
    const set = listeners.get(paneId) ?? new Set<() => void>();
    set.add(listener);
    listeners.set(paneId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(paneId);
    };
  };

  const begin = (paneId: string) => {
    const entry = panes.get(paneId) ?? { items: [], nextKey: 0 };
    const key = `attachment-${entry.nextKey}`;
    entry.nextKey += 1;
    const controller = new AbortController();
    entry.items = [...entry.items, { key, name: null, controller }];
    panes.set(paneId, entry);
    notify(paneId);
    return { key, controller };
  };

  const settle = (paneId: string, key: string, name: string) => {
    const entry = panes.get(paneId);
    if (entry === undefined || !entry.items.some((item) => item.key === key)) return;
    entry.items = entry.items.map((item) => (item.key === key ? { ...item, name } : item));
    notify(paneId);
  };

  // 外した添付は送らない。進行中のアップロードも中断する。保存済みのファイルは消さない。
  const remove = (paneId: string, key: string) => {
    const entry = panes.get(paneId);
    if (entry === undefined) return;
    const target = entry.items.find((item) => item.key === key);
    if (target === undefined) return;
    target.controller.abort();
    entry.items = entry.items.filter((item) => item.key !== key);
    if (entry.items.length === 0) panes.delete(paneId);
    notify(paneId);
  };

  const clear = (paneId: string) => {
    const entry = panes.get(paneId);
    if (entry === undefined) return;
    for (const item of entry.items) item.controller.abort();
    panes.delete(paneId);
    notify(paneId);
  };

  const prune = (isAlive: (paneId: string) => boolean) => {
    // Map の反復中に現在の要素を消しても、次へ進む。コピーは要らない。
    for (const [paneId, entry] of panes) {
      if (isAlive(paneId)) continue;
      for (const item of entry.items) item.controller.abort();
      panes.delete(paneId);
      notify(paneId);
    }
  };

  return { items, subscribe, begin, settle, remove, clear, prune };
}

// アプリ全体で 1 つ。ペインを切り替えても同じ store を読む。
export const attachmentStore = createAttachmentStore();
