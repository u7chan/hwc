import { expect, test } from "bun:test";
import type { FileTreeListing } from "../shared/file-tree";
import { createFileTreeStore, type FileTreeReader } from "./file-tree-store";

const rootListing: FileTreeListing = {
  total: 1,
  truncated: false,
  entries: [{ kind: "dir", name: "docs", path: "docs", expandable: true }],
};

const docsListing: FileTreeListing = {
  total: 1,
  truncated: false,
  entries: [
    {
      kind: "file",
      name: "mock.html",
      path: "docs/mock.html",
      open: "html",
      version: "1-3",
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 読み込みはマイクロタスクで返る。store の then を 1 回進める。
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("opens the root, expands one directory at a time, and keeps loaded children", async () => {
  const requests: string[] = [];
  const rootRead = deferred<FileTreeListing | null>();
  const docsRead = deferred<FileTreeListing | null>();
  const read: FileTreeReader = (_paneId, path) => {
    requests.push(path);
    return path === "" ? rootRead.promise : docsRead.promise;
  };
  const store = createFileTreeStore(read);

  store.open("w1:p1");
  expect(store.view("w1:p1").open).toBe(true);
  expect(requests).toEqual([""]);

  rootRead.resolve(rootListing);
  await flush();
  expect(store.view("w1:p1").dirs.get("")).toEqual(rootListing);

  store.toggle("w1:p1", "docs");
  expect(requests).toEqual(["", "docs"]);
  docsRead.resolve(docsListing);
  await flush();
  expect(store.view("w1:p1").dirs.get("docs")).toEqual(docsListing);

  // 折りたたんでも取得済みの子は捨てない。同じセッションで開き直したら取り直さない。
  store.toggle("w1:p1", "docs");
  expect(store.view("w1:p1").expanded.has("docs")).toBe(false);
  expect(store.view("w1:p1").dirs.get("docs")).toEqual(docsListing);
  store.toggle("w1:p1", "docs");
  expect(requests).toEqual(["", "docs"]);
});

test("closing discards the tree, and a late result from the old tree is ignored", async () => {
  const requests: string[] = [];
  const first = deferred<FileTreeListing | null>();
  const second = deferred<FileTreeListing | null>();
  const read: FileTreeReader = (_paneId, path) => {
    requests.push(path);
    return requests.length === 1 ? first.promise : second.promise;
  };
  const store = createFileTreeStore(read);

  store.open("w1:p1");
  store.close("w1:p1");
  expect(store.view("w1:p1").open).toBe(false);
  expect(store.view("w1:p1").dirs.size).toBe(0);

  store.open("w1:p1");
  expect(requests).toEqual(["", ""]);
  first.resolve(rootListing);
  await flush();
  // 閉じる前の応答で、開き直したツリーを汚さない。
  expect(store.view("w1:p1").dirs.size).toBe(0);

  second.resolve(rootListing);
  await flush();
  expect(store.view("w1:p1").dirs.get("")).toEqual(rootListing);
});

test("a failed directory stays a failed row and can be retried", async () => {
  let fail = true;
  const read: FileTreeReader = async () => (fail ? null : rootListing);
  const store = createFileTreeStore(read);

  store.open("w1:p1");
  await flush();
  expect(store.view("w1:p1").failed.has("")).toBe(true);

  fail = false;
  store.retry("w1:p1", "");
  expect(store.view("w1:p1").failed.has("")).toBe(false);
  await flush();
  expect(store.view("w1:p1").dirs.get("")).toEqual(rootListing);
});

test("ensure fetches the expanded directories that are still missing", async () => {
  const requests: string[] = [];
  const read: FileTreeReader = async (_paneId, path) => {
    requests.push(path);
    return path === "" ? rootListing : docsListing;
  };
  const store = createFileTreeStore(read);

  store.open("w1:p1");
  await flush();
  store.toggle("w1:p1", "docs");
  await flush();
  expect(requests).toEqual(["", "docs"]);

  // セルが外れて戻ったとき、取得済みなら何も取り直さない。
  store.ensure("w1:p1");
  expect(requests).toEqual(["", "docs"]);
});

test("keeps the selected file when the tree closes and drops it with the pane", () => {
  const store = createFileTreeStore(async () => rootListing);
  store.open("w1:p1");
  store.selectFile("w1:p1", "README.md");
  expect(store.preview("w1:p1")).toBe("README.md");

  // ツリーを閉じても、開いているファイルは残す。
  store.close("w1:p1");
  expect(store.preview("w1:p1")).toBe("README.md");
  store.open("w1:p1");
  expect(store.preview("w1:p1")).toBe("README.md");

  store.clearPreview("w1:p1");
  expect(store.preview("w1:p1")).toBeNull();

  store.selectFile("w1:p2", "LICENSE");
  store.prune((paneId) => paneId !== "w1:p2");
  expect(store.preview("w1:p2")).toBeNull();
});

test("prune drops the trees of panes that no longer exist", () => {
  const store = createFileTreeStore(async () => rootListing);
  store.open("w1:p1");
  store.open("w1:p2");

  store.prune((paneId) => paneId === "w1:p1");

  expect(store.view("w1:p1").open).toBe(true);
  expect(store.view("w1:p2").open).toBe(false);
});

test("changing the root drops the loaded rows and the selected file", async () => {
  const requests: string[] = [];
  const read: FileTreeReader = async (_paneId, path) => {
    requests.push(path);
    return path === "" ? rootListing : docsListing;
  };
  const store = createFileTreeStore(read);

  store.syncRoot("w1:p1", "/work/scratch");
  store.open("w1:p1");
  await flush();
  store.toggle("w1:p1", "docs");
  await flush();
  store.selectFile("w1:p1", "docs/mock.html");
  expect(requests).toEqual(["", "docs"]);

  // 根が変わると、同じ "" / "docs" は別の場所を指す。一覧も選択も捨てて取り直す。
  store.syncRoot("w1:p1", "/work");
  expect(store.view("w1:p1").dirs.size).toBe(0);
  expect(store.view("w1:p1").expanded.size).toBe(0);
  expect(store.preview("w1:p1")).toBeNull();
  await flush();
  expect(requests).toEqual(["", "docs", ""]);
});

test("the same root keeps the loaded rows and the selected file", async () => {
  const requests: string[] = [];
  const store = createFileTreeStore(async (_paneId, path) => {
    requests.push(path);
    return rootListing;
  });

  store.syncRoot("w1:p1", "/work/scratch");
  store.open("w1:p1");
  await flush();
  store.selectFile("w1:p1", "README.md");

  store.syncRoot("w1:p1", "/work/scratch");
  expect(requests).toEqual([""]);
  expect(store.preview("w1:p1")).toBe("README.md");
});

test("a root change while the tree is closed clears the selected file", async () => {
  const store = createFileTreeStore(async () => rootListing);

  store.syncRoot("w1:p1", "/work/scratch");
  store.open("w1:p1");
  await flush();
  store.selectFile("w1:p1", "README.md");
  store.close("w1:p1");

  // ツリーを閉じても、同じ根の間は開いているファイルを残す。
  expect(store.preview("w1:p1")).toBe("README.md");
  store.syncRoot("w1:p1", "/work");
  expect(store.preview("w1:p1")).toBeNull();
});

test("opens the row menu in one pane at a time", () => {
  const store = createFileTreeStore(async () => rootListing);
  store.open("w1:p1");
  store.open("w1:p2");

  const trigger = {} as HTMLElement;
  store.openRowMenu("w1:p1", { path: "docs", name: "docs", trigger });
  expect(store.view("w1:p1").menu).toEqual({ path: "docs", name: "docs", trigger, open: true });

  // 分割セルがそれぞれメニューを持つと、同じ id の面が 2 つ残る。開けるのは 1 つだけ。
  store.openRowMenu("w1:p2", { path: "src", name: "src", trigger });
  expect(store.view("w1:p1").menu).toBeNull();
  expect(store.view("w1:p2").menu?.path).toBe("src");
});

test("closing keeps the row menu for the fade and clearing drops it", () => {
  const store = createFileTreeStore(async () => rootListing);
  store.open("w1:p1");
  store.openRowMenu("w1:p1", { path: "docs", name: "docs", trigger: {} as HTMLElement });

  store.closeRowMenu("w1:p1", "docs");
  expect(store.view("w1:p1").menu?.open).toBe(false);

  // フェードアウトの途中で開き直したら、消さない。
  store.openRowMenu("w1:p1", { path: "docs", name: "docs", trigger: {} as HTMLElement });
  store.clearRowMenu("w1:p1", "docs");
  expect(store.view("w1:p1").menu?.open).toBe(true);

  store.closeRowMenu("w1:p1", "docs");
  store.clearRowMenu("w1:p1", "docs");
  expect(store.view("w1:p1").menu).toBeNull();
});

test("a root change drops the open row menu", async () => {
  const store = createFileTreeStore(async () => rootListing);
  store.syncRoot("w1:p1", "/work/scratch");
  store.open("w1:p1");
  await flush();
  store.openRowMenu("w1:p1", { path: "docs", name: "docs", trigger: {} as HTMLElement });

  // 相対パスは根が変わると別の場所を指す。消えた行のメニューは残さない。
  store.syncRoot("w1:p1", "/work");
  expect(store.view("w1:p1").menu).toBeNull();
});
