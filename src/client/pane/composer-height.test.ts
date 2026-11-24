import { expect, test } from "bun:test";
import { type HeightInput, heightInputAt, needsFit } from "./composer-height";

const input = (over: Partial<HeightInput> = {}): HeightInput => ({
  text: "",
  compact: false,
  expanded: false,
  disabled: false,
  ...over,
});

test("the first render is measured", () => {
  expect(needsFit(null, input())).toBe(true);
});

test("a render that changed nothing is not measured again", () => {
  expect(needsFit(input({ text: "hello" }), input({ text: "hello" }))).toBe(false);
});

test("a changed text, compact flag, expansion or disabled input is measured again", () => {
  const previous = input({ text: "hello" });

  expect(needsFit(previous, input({ text: "hello\n" }))).toBe(true);
  expect(needsFit(previous, input({ text: "hello", compact: true }))).toBe(true);
  expect(needsFit(previous, input({ text: "hello", expanded: true }))).toBe(true);
  expect(needsFit(previous, input({ text: "hello", disabled: true }))).toBe(true);
});

test("the text of a composer that is not drawn stays at the last one read", () => {
  const previous = input({ text: "hello" });

  expect(
    heightInputAt(null, previous, { compact: false, expanded: false, disabled: true }),
  ).toEqual(input({ text: "hello", disabled: true }));
});

test("the text read from the field wins over the one carried over", () => {
  const previous = input({ text: "hello" });

  expect(
    heightInputAt("hello!", previous, { compact: true, expanded: false, disabled: false }),
  ).toEqual(input({ text: "hello!", compact: true }));
});

test("a composer that never showed its text keeps it unknown", () => {
  expect(heightInputAt(null, null, { compact: false, expanded: true, disabled: true })).toEqual(
    input({ text: null, expanded: true, disabled: true }),
  );
});
