import { expect, test } from "bun:test";
import { hintLeft } from "./hint";

const MOBILE = { left: 0, width: 390 };
const DESKTOP = { left: 0, width: 1280 };

test("a panel with room on the left keeps its right edge on the anchor", () => {
  // 端末右寄りのコンテキスト使用量。右端を揃えれば 8px の余白に収まる。
  expect(hintLeft(1013, 1184, 240, DESKTOP.left, DESKTOP.width)).toBe(944);
});

test("a panel that would fall off the left edge starts at the anchor instead", () => {
  // 入力欄のモデル名は画面の左寄りにある。右端を揃えると -12px になるので左端を揃える。
  expect(hintLeft(69.5, 228, 240, MOBILE.left, MOBILE.width)).toBe(69.5);
});

test("a panel that fits neither side is pushed inside the visible area", () => {
  // 画面幅がパネルとほぼ同じときは、左右どちらに揃えても入らない。右端を 8px 内側で止める。
  expect(hintLeft(100, 140, 170, 0, 200)).toBe(22);
  expect(hintLeft(30, 70, 170, 0, 200)).toBe(22);
});

test("a viewport wider than the panel keeps both edges inside", () => {
  expect(hintLeft(0, 30, 240, 0, 320)).toBe(8);
  expect(hintLeft(300, 320, 240, 0, 320)).toBe(72);
});
