import { expect, test } from "bun:test";
import { isAbortError } from "./poll";

test("a cancellation is not a failure", () => {
  expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
  expect(isAbortError(new Error("network"))).toBe(false);
  expect(isAbortError(null)).toBe(false);
  expect(isAbortError("AbortError")).toBe(false);
});
