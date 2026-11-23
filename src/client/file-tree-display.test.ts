import { expect, test } from "bun:test";
import {
  FILE_TREE_ICONS,
  FILE_TREE_ICONS_STORAGE_KEY,
  FILE_TREE_SIZES,
  FILE_TREE_SIZE_STORAGE_KEY,
  FILE_TREE_WIDTHS,
  FILE_TREE_WIDTH_STORAGE_KEY,
  fileTreeFontSize,
  fileTreeWidthPx,
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
  expect(parseFileTreeWidth(null)).toBe("normal");
  // 標準は、設定を足す前の見た目（--text-body と 260px）のまま。--text-body は画面幅で変わるので、
  // 値ではなくトークンを指す。
  expect(fileTreeFontSize("normal")).toBe("var(--text-body)");
  expect(fileTreeWidthPx("normal")).toBe(260);
});

test("the icon marks are off until chosen, then only one style exists", () => {
  expect(parseFileTreeIcons(null)).toBe("none");
  expect(FILE_TREE_ICONS.map((option) => option.id)).toEqual(["none", "color"]);
  expect(FILE_TREE_ICONS.map((option) => option.label)).toEqual(["なし", "色分け"]);
});

test("the radiogroups offer three steps, smallest first", () => {
  expect(FILE_TREE_SIZES.map((option) => option.id)).toEqual(["small", "normal", "large"]);
  expect(FILE_TREE_WIDTHS.map((option) => option.id)).toEqual(["narrow", "normal", "wide"]);
  expect(fileTreeWidthPx("narrow")).toBeLessThan(fileTreeWidthPx("normal"));
  expect(fileTreeWidthPx("normal")).toBeLessThan(fileTreeWidthPx("wide"));
});

test("every step survives a round trip", () => {
  const storage = memory();
  for (const { id } of FILE_TREE_SIZES) {
    saveFileTreeSize(storage, id);
    expect(loadFileTreeSize(storage)).toBe(id);
  }
  for (const { id } of FILE_TREE_WIDTHS) {
    saveFileTreeWidth(storage, id);
    expect(loadFileTreeWidth(storage)).toBe(id);
  }
  for (const { id } of FILE_TREE_ICONS) {
    saveFileTreeIcons(storage, id);
    expect(loadFileTreeIcons(storage)).toBe(id);
  }
});

test("size, width and icons are stored apart", () => {
  const storage = memory();
  saveFileTreeSize(storage, "large");
  saveFileTreeWidth(storage, "wide");
  saveFileTreeIcons(storage, "color");

  expect(storage.map.get(FILE_TREE_SIZE_STORAGE_KEY)).toBe("large");
  expect(storage.map.get(FILE_TREE_WIDTH_STORAGE_KEY)).toBe("wide");
  expect(storage.map.get(FILE_TREE_ICONS_STORAGE_KEY)).toBe("color");
});

test("an unknown value falls back to the standard step", () => {
  expect(parseFileTreeSize("huge")).toBe("normal");
  expect(parseFileTreeSize("")).toBe("normal");
  // 幅の id を大きさへ読んでも拾わない。
  expect(parseFileTreeSize("wide")).toBe("normal");
  expect(parseFileTreeWidth("large")).toBe("normal");
  expect(parseFileTreeWidth("constructor")).toBe("normal");
  expect(parseFileTreeIcons("mono")).toBe("none");
  expect(parseFileTreeIcons("")).toBe("none");
});

test("an unreadable store keeps the standard step", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
  };
  expect(loadFileTreeSize(broken)).toBe("normal");
  expect(loadFileTreeWidth(broken)).toBe("normal");
  expect(loadFileTreeIcons(broken)).toBe("none");
  expect(loadFileTreeSize(null)).toBe("normal");
  expect(loadFileTreeWidth(null)).toBe("normal");
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
  expect(() => saveFileTreeWidth(broken, "wide")).not.toThrow();
  expect(() => saveFileTreeIcons(broken, "color")).not.toThrow();
  expect(() => saveFileTreeSize(null, "large")).not.toThrow();
  expect(() => saveFileTreeIcons(null, "color")).not.toThrow();
});
