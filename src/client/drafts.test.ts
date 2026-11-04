import { expect, test } from "bun:test";
import {
  DRAFT_MAX_LENGTH,
  REPLY_MAX_LENGTH,
  readDraft,
  readReply,
  replyKey,
  writeDraft,
  writeReply,
} from "./drafts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

test("a draft comes back for the same pane only", () => {
  const storage = memoryStorage();
  writeDraft(storage, "w1:p1", "書きかけ");

  expect(readDraft(storage, "w1:p1")).toBe("書きかけ");
  expect(readDraft(storage, "w1:p2")).toBe("");
});

test("an empty draft removes the entry instead of storing it", () => {
  const storage = memoryStorage();
  writeDraft(storage, "w1:p1", "書きかけ");
  writeDraft(storage, "w1:p1", "");

  expect(storage.map.size).toBe(0);
  expect(readDraft(storage, "w1:p1")).toBe("");
});

test("a very long draft is left unsaved", () => {
  const storage = memoryStorage();
  writeDraft(storage, "w1:p1", "あ".repeat(DRAFT_MAX_LENGTH + 1));

  expect(readDraft(storage, "w1:p1")).toBe("");
});

test("storage that refuses to work does not break the input", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };

  expect(readDraft(broken, "w1:p1")).toBe("");
  expect(() => writeDraft(broken, "w1:p1", "x")).not.toThrow();
  expect(readDraft(null, "w1:p1")).toBe("");
});

test("a reply comes back for the same pane only", () => {
  const storage = memoryStorage();
  writeReply(storage, "w1:p1", "引用");

  expect(readReply(storage, "w1:p1")).toBe("引用");
  expect(readReply(storage, "w1:p2")).toBe("");
});

test("the reply and the draft do not overwrite each other", () => {
  const storage = memoryStorage();
  writeReply(storage, "w1:p1", "引用");
  writeDraft(storage, "w1:p1", "下書き");

  expect(readReply(storage, "w1:p1")).toBe("引用");
  expect(readDraft(storage, "w1:p1")).toBe("下書き");
  expect(replyKey("w1:p1")).not.toBe("w1:p1");
});

test("an empty reply removes the entry instead of storing it", () => {
  const storage = memoryStorage();
  writeReply(storage, "w1:p1", "引用");
  writeReply(storage, "w1:p1", "");

  expect(storage.map.size).toBe(0);
  expect(readReply(storage, "w1:p1")).toBe("");
});

test("a reply over the limit is left unsaved", () => {
  const storage = memoryStorage();
  writeReply(storage, "w1:p1", "あ".repeat(REPLY_MAX_LENGTH));
  expect(readReply(storage, "w1:p1")).toBe("あ".repeat(REPLY_MAX_LENGTH));

  const fresh = memoryStorage();
  writeReply(fresh, "w1:p1", "あ".repeat(REPLY_MAX_LENGTH + 1));
  expect(readReply(fresh, "w1:p1")).toBe("");
});

test("storage that refuses to work does not break the reply", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };

  expect(readReply(broken, "w1:p1")).toBe("");
  expect(() => writeReply(broken, "w1:p1", "引用")).not.toThrow();
  expect(readReply(null, "w1:p1")).toBe("");
});
