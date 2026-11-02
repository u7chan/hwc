import { expect, test } from "bun:test";
import { OUTPUT_LINES, outputUrl, parseAppState, toAppState, toPaneRead } from "./api";

const state = {
  focusedWorkspaceId: null,
  focusedTabId: null,
  focusedPaneId: null,
  workspaces: [],
};

test("the output request asks for the recent lines of the pane", () => {
  const url = new URL(outputUrl("w1:p2"), "http://localhost");

  // ":" is escaped but the BFF decodes it back into the pane id.
  expect(url.pathname).toBe("/api/panes/w1%3Ap2/output");
  expect(url.searchParams.get("source")).toBe("recent");
  expect(url.searchParams.get("lines")).toBe(String(OUTPUT_LINES));
});

test("the pane id is escaped so it stays a single path segment", () => {
  expect(outputUrl("w1/p2")).toContain("/api/panes/w1%2Fp2/output");
});

test("a state body needs a workspaces array", () => {
  expect(toAppState(state)).toEqual(state);
  expect(toAppState({ workspaces: "w1" })).toBeNull();
  expect(toAppState(null)).toBeNull();
});

test("a broken event body is dropped instead of thrown", () => {
  expect(parseAppState(JSON.stringify(state))).toEqual(state);
  expect(parseAppState("{")).toBeNull();
  expect(parseAppState('"state"')).toBeNull();
});

test("an output body is accepted only for the pane that was requested", () => {
  const body = { paneId: "w1:p2", text: "hi", truncated: false, revision: 3 };

  expect(toPaneRead(body, "w1:p2")).toEqual(body);
  expect(toPaneRead(body, "w1:p3")).toBeNull();
  expect(toPaneRead({ ...body, revision: "3" }, "w1:p2")).toBeNull();
  expect(toPaneRead({ ...body, truncated: null }, "w1:p2")).toBeNull();
  expect(toPaneRead({ ...body, text: 1 }, "w1:p2")).toBeNull();
});

test("empty output is still valid output", () => {
  expect(toPaneRead({ paneId: "p", text: "", truncated: true, revision: 0 }, "p")).toEqual({
    paneId: "p",
    text: "",
    truncated: true,
    revision: 0,
  });
});
