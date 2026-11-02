import { expect, test } from "bun:test";
import {
  OUTPUT_LINES,
  chatOutcome,
  chatUrl,
  outputUrl,
  parseAppState,
  toAppState,
  toChatSnapshot,
  toPaneRead,
} from "./api";

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

test("the chat request names the pane and carries nothing else", () => {
  const url = new URL(chatUrl("w1:p2"), "http://localhost");

  expect(url.pathname).toBe("/api/panes/w1%3Ap2/chat");
  expect(url.search).toBe("");
});

test("a 304 keeps the messages already in hand", () => {
  expect(chatOutcome(304)).toBe("unchanged");
  expect(chatOutcome(200)).toBe("snapshot");
});

test("a pane without a session or without herdr falls back to the output", () => {
  expect(chatOutcome(404)).toBe("unavailable");
  expect(chatOutcome(502)).toBe("unavailable");
  expect(chatOutcome(500)).toBe("unavailable");
});

const chatBody = {
  etag: "abc",
  messages: [{ id: "m1", role: "agent" as const, text: "hi", at: 1_000 }],
  model: "pi-large",
  effort: null,
  truncated: false,
};

test("a chat body is accepted as the contract describes it", () => {
  expect(toChatSnapshot(chatBody)).toEqual(chatBody);
  expect(toChatSnapshot({ ...chatBody, messages: [] })).toEqual({ ...chatBody, messages: [] });
  expect(toChatSnapshot({ ...chatBody, model: null })).toEqual({ ...chatBody, model: null });
});

test("a chat body that breaks the contract is dropped", () => {
  expect(toChatSnapshot(null)).toBeNull();
  expect(toChatSnapshot({ ...chatBody, etag: undefined })).toBeNull();
  expect(toChatSnapshot({ ...chatBody, truncated: "no" })).toBeNull();
  // null と文字列以外は「無い」と区別できないので受けない。
  expect(toChatSnapshot({ ...chatBody, effort: undefined })).toBeNull();
  expect(toChatSnapshot({ ...chatBody, messages: null })).toBeNull();
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...chatBody.messages[0], role: "system" }] }),
  ).toBeNull();
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...chatBody.messages[0], at: "1" }] }),
  ).toBeNull();
});
