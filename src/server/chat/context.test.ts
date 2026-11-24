import { expect, test } from "bun:test";
import { foldContext } from "./context";

test("has no context when neither the tokens nor the window is known", () => {
  expect(foldContext(null, null)).toBeNull();
});

test("keeps the known side of the context as is", () => {
  expect(foldContext(1_234, null)).toEqual({ tokens: 1_234, window: null });
  expect(foldContext(null, 200_000)).toEqual({ tokens: null, window: 200_000 });
  expect(foldContext(1_234, 200_000)).toEqual({ tokens: 1_234, window: 200_000 });
});

test("does not fold a zero into null", () => {
  expect(foldContext(0, 0)).toEqual({ tokens: 0, window: 0 });
});
