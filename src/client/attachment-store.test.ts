import { expect, test } from "bun:test";
import { createAttachmentStore } from "./attachment-store";

test("attachments are kept per pane", () => {
  const store = createAttachmentStore();
  const first = store.begin("w1:p1", 1200);
  const second = store.begin("w1:p1", 1200);
  const other = store.begin("w1:p2", 4096);

  expect(store.items("w1:p1").map((item) => item.key)).toEqual([first.key, second.key]);
  expect(store.items("w1:p2").map((item) => item.key)).toEqual([other.key]);
  expect(store.items("w1:p3")).toEqual([]);
});

test("a pending upload is still there when its pane is shown again", () => {
  const store = createAttachmentStore();
  const { key } = store.begin("w1:p1", 1200);
  const unsubscribe = store.subscribe("w1:p1", () => undefined);
  unsubscribe();

  expect(store.items("w1:p1").map((item) => [item.key, item.name])).toEqual([[key, null]]);

  store.settle("w1:p1", key, "pasted-20260101-000000.png");

  expect(store.items("w1:p1").map((item) => [item.key, item.name])).toEqual([
    [key, "pasted-20260101-000000.png"],
  ]);
});

test("removing an attachment aborts its upload and a late result does not bring it back", () => {
  const store = createAttachmentStore();
  const { key, controller } = store.begin("w1:p1", 1200);

  store.remove("w1:p1", key);
  store.settle("w1:p1", key, "pasted-20260101-000000.png");

  expect(controller.signal.aborted).toBe(true);
  expect(store.items("w1:p1")).toEqual([]);
});

test("clearing after a send aborts every upload and empties the pane", () => {
  const store = createAttachmentStore();
  const first = store.begin("w1:p1", 1200);
  const second = store.begin("w1:p1", 1200);

  store.clear("w1:p1");

  expect(first.controller.signal.aborted).toBe(true);
  expect(second.controller.signal.aborted).toBe(true);
  expect(store.items("w1:p1")).toEqual([]);
});

test("pruning drops only the panes that are gone", () => {
  const store = createAttachmentStore();
  const kept = store.begin("w1:p1", 1200);
  const gone = store.begin("w1:p2", 4096);

  store.prune((paneId) => paneId === "w1:p1");

  expect(gone.controller.signal.aborted).toBe(true);
  expect(store.items("w1:p2")).toEqual([]);
  expect(store.items("w1:p1").map((item) => item.key)).toEqual([kept.key]);
});
