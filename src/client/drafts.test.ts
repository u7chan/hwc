import { expect, test } from "bun:test";
import { DRAFT_MAX_LENGTH, readDraft, writeDraft } from "./drafts";

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
