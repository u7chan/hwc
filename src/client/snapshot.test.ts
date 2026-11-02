import { expect, test } from "bun:test";
import { gateSnapshot } from "./snapshot";

test("the initial fetch fills in the state until the stream speaks", () => {
  expect(gateSnapshot("initial-fetch", "initial-fetch")).toEqual({
    writer: "initial-fetch",
    apply: true,
  });
});

test("the stream snapshot takes over and is always applied", () => {
  expect(gateSnapshot("initial-fetch", "stream")).toEqual({ writer: "stream", apply: true });
  expect(gateSnapshot("stream", "stream")).toEqual({ writer: "stream", apply: true });
});

test("a late initial fetch does not overwrite the streamed state", () => {
  expect(gateSnapshot("stream", "initial-fetch")).toEqual({ writer: "stream", apply: false });
});
