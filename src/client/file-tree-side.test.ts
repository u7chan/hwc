import { expect, test } from "bun:test";
import {
  DEFAULT_FILE_TREE_SIDE,
  FILE_TREE_SIDES,
  loadFileTreeSide,
  parseFileTreeSide,
  saveFileTreeSide,
} from "./file-tree-side";

function memory(initial: string | null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    current: () => value,
  };
}

test("an empty value starts on the left", () => {
  expect(parseFileTreeSide(null)).toBe("left");
  expect(DEFAULT_FILE_TREE_SIDE).toBe("left");
});

test("both sides survive a round trip", () => {
  const storage = memory(null);
  saveFileTreeSide(storage, "right");
  expect(storage.current()).toBe("right");
  expect(loadFileTreeSide(storage)).toBe("right");

  // 既定へ戻す側も、同じ key に書いて読めること。
  saveFileTreeSide(storage, "left");
  expect(loadFileTreeSide(storage)).toBe("left");
});

test("an unknown value falls back to the left", () => {
  expect(parseFileTreeSide("top")).toBe("left");
  expect(parseFileTreeSide("")).toBe("left");
});

test("the radiogroup offers both sides", () => {
  expect(FILE_TREE_SIDES.map((option) => option.id)).toEqual(["left", "right"]);
});

test("an unreadable store keeps the default", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
  };
  expect(loadFileTreeSide(broken)).toBe("left");
  expect(loadFileTreeSide(null)).toBe("left");
});

test("a store that rejects writes is ignored", () => {
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  };
  expect(() => saveFileTreeSide(broken, "right")).not.toThrow();
});
