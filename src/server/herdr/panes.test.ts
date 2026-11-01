import { expect, test } from "bun:test";
import { HerdrError } from "./socket";
import { createPaneClient, isPaneNotFound, parseInputBody, parseOutputQuery } from "./panes";

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
  read: { text: "hello\n", truncated: true, revision: 12, format: "text", source: "recent" },
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
    "pane_read.read",
  );
});

test("send sends the text only when submit is false", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ call });

  await client.send({ paneId: "w1:p1", text: "hello", submit: false });

  expect(calls.map((call) => call.method)).toEqual(["pane.send_text"]);
  expect(calls[0]?.params).toEqual({ pane_id: "w1:p1", text: "hello" });
});

test("send presses Enter after the text when submit is true", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ call });

  await client.send({ paneId: "w1:p1", text: "hello", submit: true });

  expect(calls.map((call) => call.method)).toEqual(["pane.send_text", "pane.send_keys"]);
  expect(calls[1]?.params).toEqual({ pane_id: "w1:p1", keys: ["Enter"] });
});

test("send stops when the text is rejected", async () => {
  const { calls, call } = recordingCaller({
    "pane.send_text": new HerdrError("pane_not_found", "pane w1:p1 not found"),
  });
  const client = createPaneClient({ call });

  await expect(client.send({ paneId: "w1:p1", text: "hello", submit: true })).rejects.toThrow(
    "pane_not_found",
  );
  expect(calls.map((call) => call.method)).toEqual(["pane.send_text"]);
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
  expect(parseInputBody({})).toEqual({ ok: false, error: "text must be a non-empty string" });
  expect(parseInputBody({ text: "" })).toEqual({
    ok: false,
    error: "text must be a non-empty string",
  });
  expect(parseInputBody({ text: "   " })).toEqual({
    ok: false,
    error: "text must be a non-empty string",
  });
  expect(parseInputBody({ text: 42 })).toEqual({
    ok: false,
    error: "text must be a non-empty string",
  });
});

test("parseInputBody rejects a body that is not an object", () => {
  expect(parseInputBody(null)).toEqual({ ok: false, error: "body must be an object" });
  expect(parseInputBody(["hello"])).toEqual({ ok: false, error: "body must be an object" });
  expect(parseInputBody("hello")).toEqual({ ok: false, error: "body must be an object" });
});

test("parseInputBody rejects a submit that is not a boolean", () => {
  expect(parseInputBody({ text: "hello", submit: "yes" })).toEqual({
    ok: false,
    error: "submit must be a boolean",
  });
});

test("isPaneNotFound tells a missing pane apart from other failures", () => {
  expect(isPaneNotFound(new HerdrError("pane_not_found", "pane w1:p1 not found"))).toBe(true);
  expect(isPaneNotFound(new HerdrError("invalid_params", "bad params"))).toBe(false);
  expect(isPaneNotFound(new Error("pane_not_found"))).toBe(false);
});
