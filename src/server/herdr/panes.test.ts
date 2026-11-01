import { expect, test } from "bun:test";
import { HerdrError } from "./socket";
import {
  createPaneClient,
  isInvalidRequest,
  isPaneNotFound,
  parseInputBody,
  parseOutputQuery,
} from "./panes";

type Call = { method: string; params: unknown; options: unknown };

function recordingCaller(replies: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const call = async <T>(method: string, params?: unknown, options?: unknown): Promise<T> => {
    calls.push({ method, params, options });
    if (!(method in replies)) return {} as T;
    const reply = replies[method];
    if (reply instanceof Error) throw reply;
    return reply as T;
  };
  return { calls, call };
}

const paneReadReply = {
  type: "pane_read",
  read: {
    pane_id: "w1:p1",
    text: "hello\n",
    truncated: true,
    revision: 12,
    format: "text",
    source: "recent",
  },
};

test("read maps the request to pane.read and returns the output", async () => {
  const { calls, call } = recordingCaller({ "pane.read": paneReadReply });
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  const output = await client.read({ paneId: "w1:p1", source: "recent", lines: 40 });

  expect(calls).toEqual([
    {
      method: "pane.read",
      params: { pane_id: "w1:p1", source: "recent", lines: 40, format: "text" },
      options: { path: "/tmp/test.sock" },
    },
  ]);
  expect(output).toEqual({ paneId: "w1:p1", text: "hello\n", truncated: true, revision: 12 });
});

test("read omits lines when the request does not set one", async () => {
  const { calls, call } = recordingCaller({ "pane.read": paneReadReply });
  const client = createPaneClient({ call });

  await client.read({ paneId: "w1:p1", source: "visible" });

  expect(calls[0]?.params).toEqual({ pane_id: "w1:p1", source: "visible", format: "text" });
});

test("read fails when Herdr answers with something else than a pane read", async () => {
  const { call } = recordingCaller({ "pane.read": { type: "ok" } });
  const client = createPaneClient({ call });

  await expect(client.read({ paneId: "w1:p1", source: "recent" })).rejects.toThrow(
    "pane_read.type must be pane_read",
  );
});

test("send sends the text only when submit is false", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ call });

  await client.send({ paneId: "w1:p1", text: "hello", submit: false });

  expect(calls.map((call) => call.method)).toEqual(["pane.send_input"]);
  expect(calls[0]?.params).toEqual({ pane_id: "w1:p1", text: "hello" });
});

test("send sends the text and Enter in one request when submit is true", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ call });

  await client.send({ paneId: "w1:p1", text: "hello", submit: true });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.params).toEqual({ pane_id: "w1:p1", text: "hello", keys: ["enter"] });
});

test("send keeps multi-line text as it is and leaves Enter to submit", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ call });

  await client.send({ paneId: "w1:p1", text: "line 1\nline 2", submit: false });

  expect(calls[0]?.params).toEqual({ pane_id: "w1:p1", text: "line 1\nline 2" });
});

test("send reports the failure without a second request", async () => {
  const { calls, call } = recordingCaller({
    "pane.send_input": new HerdrError("pane_not_found", "pane w1:p1 not found"),
  });
  const client = createPaneClient({ call });

  await expect(client.send({ paneId: "w1:p1", text: "hello", submit: true })).rejects.toThrow(
    "pane_not_found",
  );
  expect(calls.map((call) => call.method)).toEqual(["pane.send_input"]);
});

test("parseOutputQuery defaults to the recent output", () => {
  expect(parseOutputQuery(new URLSearchParams())).toEqual({
    ok: true,
    value: { source: "recent" },
  });
  expect(parseOutputQuery(new URLSearchParams("source=visible&lines=10"))).toEqual({
    ok: true,
    value: { source: "visible", lines: 10 },
  });
});

test("parseOutputQuery rejects an unknown source", () => {
  expect(parseOutputQuery(new URLSearchParams("source=scrollback"))).toEqual({
    ok: false,
    status: 400,
    error: "source must be one of visible, recent, recent_unwrapped, detection",
  });
});

test("parseOutputQuery rejects lines that are out of range", () => {
  for (const lines of ["0", "-1", "1.5", "abc", "4294967296"]) {
    const parsed = parseOutputQuery(new URLSearchParams({ lines }));
    expect(parsed.ok).toBe(false);
  }
  expect(parseOutputQuery(new URLSearchParams("lines=1"))).toEqual({
    ok: true,
    value: { source: "recent", lines: 1 },
  });
  expect(parseOutputQuery(new URLSearchParams("lines=4294967295"))).toEqual({
    ok: true,
    value: { source: "recent", lines: 4294967295 },
  });
});

test("parseInputBody accepts text with an optional submit", () => {
  expect(parseInputBody({ text: "hello" })).toEqual({
    ok: true,
    value: { text: "hello", submit: false },
  });
  expect(parseInputBody({ text: "hello", submit: true })).toEqual({
    ok: true,
    value: { text: "hello", submit: true },
  });
});

test("parseInputBody rejects a missing or blank text", () => {
  const rejected = {
    ok: false as const,
    status: 400 as const,
    error: "text must be a non-empty string",
  };
  expect(parseInputBody({})).toEqual(rejected);
  expect(parseInputBody({ text: "" })).toEqual(rejected);
  expect(parseInputBody({ text: "   " })).toEqual(rejected);
  expect(parseInputBody({ text: 42 })).toEqual(rejected);
});

test("parseInputBody rejects a body that is not an object", () => {
  const rejected = { ok: false as const, status: 400 as const, error: "body must be an object" };
  expect(parseInputBody(null)).toEqual(rejected);
  expect(parseInputBody(["hello"])).toEqual(rejected);
  expect(parseInputBody("hello")).toEqual(rejected);
});

test("parseInputBody rejects a text that is too long", () => {
  expect(parseInputBody({ text: "a".repeat(16_385) })).toEqual({
    ok: false,
    status: 413,
    error: "text must be at most 16384 bytes",
  });
  expect(parseInputBody({ text: "a".repeat(16_384) }).ok).toBe(true);
  // 3 バイト文字はバイト数で数える。
  expect(parseInputBody({ text: "あ".repeat(5_462) }).ok).toBe(false);
});

test("parseInputBody rejects a submit that is not a boolean", () => {
  expect(parseInputBody({ text: "hello", submit: "yes" })).toEqual({
    ok: false,
    status: 400,
    error: "submit must be a boolean",
  });
});

test("isPaneNotFound tells a missing pane apart from other failures", () => {
  expect(isPaneNotFound(new HerdrError("pane_not_found", "pane w1:p1 not found"))).toBe(true);
  expect(isPaneNotFound(new HerdrError("invalid_params", "bad params"))).toBe(false);
  expect(isPaneNotFound(new Error("pane_not_found"))).toBe(false);
});

test("isInvalidRequest tells a rejected request apart from other failures", () => {
  expect(isInvalidRequest(new HerdrError("invalid_params", "bad params"))).toBe(true);
  expect(isInvalidRequest(new HerdrError("invalid_request", "bad request"))).toBe(true);
  expect(isInvalidRequest(new HerdrError("pane_not_found", "missing"))).toBe(false);
  expect(isInvalidRequest(new Error("invalid_params"))).toBe(false);
});
