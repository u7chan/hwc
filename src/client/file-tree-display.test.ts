import { expect, test } from "bun:test";
import {
  DEFAULT_FILE_TREE_WIDTH,
  FILE_TREE_ICONS,
  FILE_TREE_ICONS_STORAGE_KEY,
  FILE_TREE_SIZES,
  FILE_TREE_SIZE_STORAGE_KEY,
  FILE_TREE_WIDTH_MAX,
  FILE_TREE_WIDTH_MIN,
  FILE_TREE_WIDTH_STORAGE_KEY,
  clampFileTreeWidth,
  fileTreeFontSize,
  fileTreeWidthByDrag,
  loadFileTreeIcons,
  loadFileTreeSize,
  loadFileTreeWidth,
  parseFileTreeIcons,
  parseFileTreeSize,
  parseFileTreeWidth,
  saveFileTreeIcons,
  saveFileTreeSize,
  saveFileTreeWidth,
} from "./file-tree-display";
import { treeSideMinWidth } from "./layout";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

test("an empty value keeps today's size and width", () => {
  expect(parseFileTreeSize(null)).toBe("normal");
  expect(parseFileTreeWidth(null)).toBe(260);
  expect(DEFAULT_FILE_TREE_WIDTH).toBe(260);
  // 標準は、設定を足す前の見た目（--text-body）のまま。--text-body は画面幅で変わるので、
  // 値ではなくトークンを指す。
  expect(fileTreeFontSize("normal")).toBe("var(--text-body)");
});

test("the icon marks are off until chosen, then only one style exists", () => {
  expect(parseFileTreeIcons(null)).toBe("none");
  expect(FILE_TREE_ICONS.map((option) => option.id)).toEqual(["none", "color"]);
  expect(FILE_TREE_ICONS.map((option) => option.label)).toEqual(["なし", "色分け"]);
});

test("the font size radiogroup offers three steps, smallest first", () => {
  expect(FILE_TREE_SIZES.map((option) => option.id)).toEqual(["small", "normal", "large"]);
});

test("the width is a number a hand can set, kept inside what the rows can show", () => {
  expect(clampFileTreeWidth(300)).toBe(300);
  expect(clampFileTreeWidth(FILE_TREE_WIDTH_MIN - 100)).toBe(FILE_TREE_WIDTH_MIN);
  expect(clampFileTreeWidth(FILE_TREE_WIDTH_MAX + 100)).toBe(FILE_TREE_WIDTH_MAX);
  expect(clampFileTreeWidth(300.4)).toBe(300);
  expect(clampFileTreeWidth(Number.NaN)).toBe(DEFAULT_FILE_TREE_WIDTH);
});

test("dragging never leaves the chat narrower than the tree sits beside", () => {
  // 800px のセルなら 380px まで。そのとき会話に 420px が残り、並べたままでいられる。
  const cell = 800;
  const widest = clampFileTreeWidth(FILE_TREE_WIDTH_MAX, cell);
  expect(widest).toBe(380);
  expect(treeSideMinWidth(widest)).toBe(cell);
  expect(clampFileTreeWidth(FILE_TREE_WIDTH_MAX, 2000)).toBe(FILE_TREE_WIDTH_MAX);
  // 並べられないほど狭いセルでも、最小より狭くはしない。
  expect(clampFileTreeWidth(300, 500)).toBe(FILE_TREE_WIDTH_MIN);
});

test("the tree on the left grows with the divider and the tree on the right shrinks", () => {
  expect(fileTreeWidthByDrag(260, 40, "left")).toBe(300);
  expect(fileTreeWidthByDrag(260, -40, "left")).toBe(220);
  expect(fileTreeWidthByDrag(260, 40, "right")).toBe(220);
  expect(fileTreeWidthByDrag(260, -40, "right")).toBe(300);
});

test("every value survives a round trip", () => {
  const storage = memory();
  for (const { id } of FILE_TREE_SIZES) {
    saveFileTreeSize(storage, id);
    expect(loadFileTreeSize(storage)).toBe(id);
  }
  for (const width of [FILE_TREE_WIDTH_MIN, 300, FILE_TREE_WIDTH_MAX]) {
    saveFileTreeWidth(storage, width);
    expect(loadFileTreeWidth(storage)).toBe(width);
  }
  for (const { id } of FILE_TREE_ICONS) {
    saveFileTreeIcons(storage, id);
    expect(loadFileTreeIcons(storage)).toBe(id);
  }
});

test("size, width and icons are stored apart", () => {
  const storage = memory();
  saveFileTreeSize(storage, "large");
  saveFileTreeWidth(storage, 340);
  saveFileTreeIcons(storage, "color");

  expect(storage.map.get(FILE_TREE_SIZE_STORAGE_KEY)).toBe("large");
  expect(storage.map.get(FILE_TREE_WIDTH_STORAGE_KEY)).toBe("340");
  expect(storage.map.get(FILE_TREE_ICONS_STORAGE_KEY)).toBe("color");
});

test("a width outside the range is not stored as it is", () => {
  const storage = memory();
  saveFileTreeWidth(storage, FILE_TREE_WIDTH_MAX + 100);
  expect(storage.map.get(FILE_TREE_WIDTH_STORAGE_KEY)).toBe(String(FILE_TREE_WIDTH_MAX));
  saveFileTreeWidth(storage, Number.NaN);
  expect(storage.map.get(FILE_TREE_WIDTH_STORAGE_KEY)).toBe(String(DEFAULT_FILE_TREE_WIDTH));
});

test("an unknown value falls back to the standard", () => {
  expect(parseFileTreeSize("huge")).toBe("normal");
  expect(parseFileTreeSize("")).toBe("normal");
  expect(parseFileTreeSize("wide")).toBe("normal");
  expect(parseFileTreeWidth("wide")).toBe(DEFAULT_FILE_TREE_WIDTH);
  expect(parseFileTreeWidth("")).toBe(DEFAULT_FILE_TREE_WIDTH);
  expect(parseFileTreeWidth("  ")).toBe(DEFAULT_FILE_TREE_WIDTH);
  expect(parseFileTreeWidth("constructor")).toBe(DEFAULT_FILE_TREE_WIDTH);
  expect(parseFileTreeWidth("9999")).toBe(FILE_TREE_WIDTH_MAX);
  expect(parseFileTreeIcons("mono")).toBe("none");
  expect(parseFileTreeIcons("")).toBe("none");
});

test("an unreadable store keeps the standard", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
  };
  expect(loadFileTreeSize(broken)).toBe("normal");
  expect(loadFileTreeWidth(broken)).toBe(DEFAULT_FILE_TREE_WIDTH);
  expect(loadFileTreeIcons(broken)).toBe("none");
  expect(loadFileTreeSize(null)).toBe("normal");
  expect(loadFileTreeWidth(null)).toBe(DEFAULT_FILE_TREE_WIDTH);
  expect(loadFileTreeIcons(null)).toBe("none");
});

test("a store that rejects writes is ignored", () => {
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  };
  expect(() => saveFileTreeSize(broken, "large")).not.toThrow();
  expect(() => saveFileTreeWidth(broken, 340)).not.toThrow();
  expect(() => saveFileTreeIcons(broken, "color")).not.toThrow();
  expect(() => saveFileTreeSize(null, "large")).not.toThrow();
  expect(() => saveFileTreeWidth(null, 340)).not.toThrow();
  expect(() => saveFileTreeIcons(null, "color")).not.toThrow();
});
