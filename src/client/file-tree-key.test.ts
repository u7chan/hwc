import { expect, test } from "bun:test";
import { isFileTreeShortcut, treeArrowIntent } from "./file-tree-key";

function press(patch: Partial<Parameters<typeof isFileTreeShortcut>[0]> = {}) {
  return isFileTreeShortcut({
    key: "f",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    ...patch,
  });
}

test("f toggles the tree, and Shift+f reaches the same shortcut", () => {
  expect(press()).toBe(true);
  expect(press({ key: "F" })).toBe(true);
});

test("other letters stay with the page", () => {
  for (const key of ["g", "e", "Escape", "Enter", ""]) expect(press({ key })).toBe(false);
});

test("a modified key belongs to the browser and the OS", () => {
  // Ctrl/Cmd+f は検索。Alt はメニューやアクセント入力。
  expect(press({ ctrlKey: true })).toBe(false);
  expect(press({ metaKey: true })).toBe(false);
  expect(press({ altKey: true })).toBe(false);
});

test("holding the key does not toggle back and forth", () => {
  expect(press({ repeat: true })).toBe(false);
});

test("a key under IME composition stays with the converter", () => {
  expect(press({ isComposing: true })).toBe(false);
});

function arrow(key: string, row: { dir: boolean; expanded: boolean }) {
  return treeArrowIntent(
    { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false },
    row,
  );
}

const DIR = { dir: true, expanded: false };
const OPEN_DIR = { dir: true, expanded: true };
const FILE = { dir: false, expanded: false };

test("up and down move between rows", () => {
  for (const row of [DIR, OPEN_DIR, FILE]) {
    expect(arrow("ArrowDown", row)).toBe("next");
    expect(arrow("ArrowUp", row)).toBe("previous");
  }
});

test("right opens a closed folder, then steps into the open one", () => {
  expect(arrow("ArrowRight", DIR)).toBe("expand");
  expect(arrow("ArrowRight", OPEN_DIR)).toBe("in");
  // ファイルに子は無い。行を動かさない。
  expect(arrow("ArrowRight", FILE)).toBeNull();
});

test("left closes an open folder and otherwise steps out to the parent", () => {
  expect(arrow("ArrowLeft", OPEN_DIR)).toBe("collapse");
  expect(arrow("ArrowLeft", DIR)).toBe("out");
  expect(arrow("ArrowLeft", FILE)).toBe("out");
});

test("modified arrows stay with the browser", () => {
  for (const patch of [
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ]) {
    expect(
      treeArrowIntent(
        {
          key: "ArrowLeft",
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          ...patch,
        },
        DIR,
      ),
    ).toBeNull();
  }
});
