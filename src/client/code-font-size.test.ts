import { expect, test } from "bun:test";
import {
  CODE_FONT_SIZE_STORAGE_KEY,
  CODE_FONT_SIZES,
  codeFontSize,
  loadCodeFontSize,
  parseCodeFontSize,
  saveCodeFontSize,
} from "./code-font-size";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

test("an empty value keeps today's code size", () => {
  expect(parseCodeFontSize(null)).toBe("normal");
  // 標準は設定を足す前の --text-mono のまま。値ではなくトークンを指す。
  expect(codeFontSize("normal")).toBe("var(--text-mono)");
});

test("small and large scale the same token, so the ratio holds at any width", () => {
  expect(codeFontSize("small")).toBe("calc(var(--text-mono) * 0.85)");
  expect(codeFontSize("large")).toBe("calc(var(--text-mono) * 1.2)");
  expect(CODE_FONT_SIZES.map((option) => option.id)).toEqual(["small", "normal", "large"]);
});

test("an unknown stored value falls back to the default", () => {
  expect(parseCodeFontSize("huge")).toBe("normal");
  expect(loadCodeFontSize({ getItem: () => "huge" })).toBe("normal");
});

test("the chosen size is saved and read back", () => {
  const storage = memory();
  saveCodeFontSize(storage, "large");
  expect(storage.map.get(CODE_FONT_SIZE_STORAGE_KEY)).toBe("large");
  expect(loadCodeFontSize(storage)).toBe("large");
});

test("an unavailable storage neither throws nor loses the default", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(loadCodeFontSize(broken)).toBe("normal");
  expect(() => saveCodeFontSize(broken, "small")).not.toThrow();
  expect(loadCodeFontSize(null)).toBe("normal");
  expect(() => saveCodeFontSize(null, "small")).not.toThrow();
});
