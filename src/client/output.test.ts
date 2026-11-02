import { expect, test } from "bun:test";
import { OUTPUT_POLL_MS } from "./api";
import { pollDelay } from "./output";

test("the visible pane is read again after the polling interval", () => {
  expect(pollDelay("visible")).toBe(OUTPUT_POLL_MS);
});

test("a hidden page stops polling until it is visible again", () => {
  expect(pollDelay("hidden")).toBeNull();
});
