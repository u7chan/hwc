import { expect, test } from "bun:test";
import { enterInsertsNewline } from "./input";

test("a touch device inserts a newline on Enter instead of sending", () => {
  const coarse = (query: string) => query === "(pointer: coarse)";
  expect(enterInsertsNewline(coarse)).toBe(true);

  // マウスのある端末は従来どおり Enter で送る。
  const fine = () => false;
  expect(enterInsertsNewline(fine)).toBe(false);
});
