import { expect, test } from "bun:test";
import { HerdrError } from "./socket";
import {
  agentNameForPane,
  createPaneClient,
  exceedsTextLimit,
  isInvalidRequest,
  isPaneNotFound,
  parseInputBody,
  parseOutputQuery,
  parseProcessInfo,
  parseSplitBody,
  parseStartBody,
  restartAgentName,
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
    format: "ansi",
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
      params: { pane_id: "w1:p1", source: "recent", lines: 40, format: "ansi", strip_ansi: false },
      options: { path: "/tmp/test.sock" },
    },
  ]);
  expect(output).toEqual({ paneId: "w1:p1", text: "hello\n", truncated: true, revision: 12 });
});

test("read omits lines when the request does not set one", async () => {
  const { calls, call } = recordingCaller({ "pane.read": paneReadReply });
  const client = createPaneClient({ call });

  await client.read({ paneId: "w1:p1", source: "visible" });

  expect(calls[0]?.params).toEqual({
    pane_id: "w1:p1",
    source: "visible",
    format: "ansi",
    strip_ansi: false,
  });
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

test("stop sends Escape to the pane", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  await client.stop({ paneId: "w1:p1" });

  expect(calls).toEqual([
    {
      method: "pane.send_keys",
      params: { pane_id: "w1:p1", keys: ["esc"] },
      options: { path: "/tmp/test.sock" },
    },
  ]);
});

test("folder trust confirmation sends Enter without text or other keys", async () => {
  const { calls, call } = recordingCaller();
  await createPaneClient({ path: "/tmp/test.sock", call }).confirmFolderTrust({ paneId: "w1:p1" });
  expect(calls).toEqual([
    {
      method: "pane.send_keys",
      params: { pane_id: "w1:p1", keys: ["enter"] },
      options: { path: "/tmp/test.sock" },
    },
  ]);
});

test("stop reports the failure so the route can map it", async () => {
  const { call } = recordingCaller({
    "pane.send_keys": new HerdrError("pane_not_found", "no pane w1:p9"),
  });
  const client = createPaneClient({ call });

  await expect(client.stop({ paneId: "w1:p9" })).rejects.toThrow("pane_not_found");
});

test("clear asks Herdr to clear the pane screen and scrollback", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  await client.clear({ paneId: "w1:p1" });

  expect(calls).toEqual([
    { method: "pane.clear", params: { pane_id: "w1:p1" }, options: { path: "/tmp/test.sock" } },
  ]);
});

test("clear reports the failure so the route can map it", async () => {
  const { call } = recordingCaller({
    "pane.clear": new HerdrError("pane_not_found", "no pane w1:p9"),
  });
  const client = createPaneClient({ call });

  await expect(client.clear({ paneId: "w1:p9" })).rejects.toThrow("pane_not_found");
});

test("focus asks Herdr to focus the pane by id", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  await client.focus({ paneId: "w1:p1" });

  expect(calls).toEqual([
    { method: "agent.focus", params: { target: "w1:p1" }, options: { path: "/tmp/test.sock" } },
  ]);
});

test("focus reports the failure so the route can map it", async () => {
  const { call } = recordingCaller({
    "agent.focus": new HerdrError("agent_not_found", "no agent in w1:p9"),
  });
  const client = createPaneClient({ call });

  await expect(client.focus({ paneId: "w1:p9" })).rejects.toThrow("agent_not_found");
});

test("close asks Herdr to close the pane by id", async () => {
  const { calls, call } = recordingCaller();
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  await client.close({ paneId: "w1:p1" });

  expect(calls).toEqual([
    { method: "pane.close", params: { pane_id: "w1:p1" }, options: { path: "/tmp/test.sock" } },
  ]);
});

test("close reports the failure so the route can map it", async () => {
  const { call } = recordingCaller({
    "pane.close": new HerdrError("pane_not_found", "no pane w1:p9"),
  });
  const client = createPaneClient({ call });

  await expect(client.close({ paneId: "w1:p9" })).rejects.toThrow("pane_not_found");
});

const processInfoReply = {
  type: "pane_process_info",
  process_info: { pane_id: "w1:p1", shell_pid: 100, foreground_process_group_id: 200 },
};

test("exit requests /quit through the guarded agent API only when a parent shell remains", async () => {
  const { calls, call } = recordingCaller({ "pane.process_info": processInfoReply });
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  await client.exit({ paneId: "w1:p1" });

  expect(calls).toEqual([
    {
      method: "pane.process_info",
      params: { pane_id: "w1:p1" },
      options: { path: "/tmp/test.sock" },
    },
    {
      method: "agent.get",
      params: { target: "w1:p1" },
      options: { path: "/tmp/test.sock", timeoutMs: 2_000 },
    },
    {
      method: "agent.prompt",
      params: { target: "w1:p1", text: "/quit" },
      options: { path: "/tmp/test.sock" },
    },
  ]);
});

test.each([
  null,
  {},
  { ...processInfoReply, type: "ok" },
  { ...processInfoReply, process_info: { ...processInfoReply.process_info, pane_id: "w1:p2" } },
  { ...processInfoReply, process_info: { ...processInfoReply.process_info, shell_pid: null } },
  { ...processInfoReply, process_info: { ...processInfoReply.process_info, shell_pid: 0 } },
  {
    ...processInfoReply,
    process_info: { ...processInfoReply.process_info, foreground_process_group_id: null },
  },
  {
    ...processInfoReply,
    process_info: { ...processInfoReply.process_info, foreground_process_group_id: 100 },
  },
])(
  "exit refuses missing process facts and agents running directly under the PTY: %j",
  async (reply) => {
    const { calls, call } = recordingCaller({ "pane.process_info": reply });
    const client = createPaneClient({ call });

    await expect(client.exit({ paneId: "w1:p1" })).rejects.toThrow("agent_exit_unsafe");
    expect(calls.map((call) => call.method)).toEqual(["pane.process_info"]);
  },
);

test.each(["agent_not_ready", "agent_blocked"])(
  "exit never falls back to pane.close after %s",
  async (code) => {
    const { calls, call } = recordingCaller({
      "pane.process_info": processInfoReply,
      "agent.prompt": new HerdrError(code, "cannot send input"),
    });
    const client = createPaneClient({ call });

    await expect(client.exit({ paneId: "w1:p1" })).rejects.toThrow(code);
    expect(calls.map((call) => call.method)).toEqual([
      "pane.process_info",
      "agent.get",
      "agent.prompt",
    ]);
  },
);

test("exit still prompts when the launch lookup fails", async () => {
  const { calls, call } = recordingCaller({
    "pane.process_info": processInfoReply,
    "agent.get": new HerdrError("agent_not_found", "no agent"),
  });
  const client = createPaneClient({ call });

  await client.exit({ paneId: "w1:p1" });

  expect(calls.map((call) => call.method)).toEqual([
    "pane.process_info",
    "agent.get",
    "agent.prompt",
  ]);
});

const paneLayoutReply = {
  type: "pane_layout",
  layout: {
    workspace_id: "w1",
    tab_id: "w1:t1",
    zoomed: false,
    area: { x: 0, y: 0, width: 240, height: 48 },
    focused_pane_id: "w1:p1",
    panes: [
      { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 120, height: 48 } },
      { pane_id: "w1:p2", focused: false, rect: { x: 120, y: 0, width: 120, height: 48 } },
    ],
    splits: [],
  },
};

test("layout reads the cell sizes of the pane's tab", async () => {
  const { calls, call } = recordingCaller({ "pane.layout": paneLayoutReply });
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  const layout = await client.layout({ paneId: "w1:p1" });

  expect(calls).toEqual([
    {
      method: "pane.layout",
      params: { pane_id: "w1:p1" },
      options: { path: "/tmp/test.sock" },
    },
  ]);
  expect(layout).toEqual({
    cells: [
      { paneId: "w1:p1", width: 120, height: 48 },
      { paneId: "w1:p2", width: 120, height: 48 },
    ],
  });
});

test("layout fails when Herdr answers with something else", async () => {
  const { call } = recordingCaller({ "pane.layout": { type: "ok" } });
  const client = createPaneClient({ call });

  await expect(client.layout({ paneId: "w1:p1" })).rejects.toThrow(
    "pane_layout.type must be pane_layout",
  );
});

test("split asks Herdr to split the target pane without moving focus", async () => {
  const { calls, call } = recordingCaller({
    "pane.split": { type: "pane_info", pane: { pane_id: "w1:p2" } },
  });
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  const created = await client.split({ paneId: "w1:p1", direction: "down", ratio: 0.5 });

  expect(calls).toEqual([
    {
      method: "pane.split",
      params: { target_pane_id: "w1:p1", direction: "down", ratio: 0.5 },
      options: { path: "/tmp/test.sock" },
    },
  ]);
  expect(created).toEqual({ paneId: "w1:p2" });
});

test("split fails when the response has no pane id", async () => {
  const { call } = recordingCaller({ "pane.split": { type: "pane_info", pane: {} } });
  const client = createPaneClient({ call });

  await expect(client.split({ paneId: "w1:p1", direction: "right", ratio: 0.5 })).rejects.toThrow(
    "pane_info.pane.pane_id",
  );
});

test("split reports the failure so the route can map it", async () => {
  const { call } = recordingCaller({
    "pane.split": new HerdrError("pane_split_failed", "could not split"),
  });
  const client = createPaneClient({ call });

  await expect(client.split({ paneId: "w1:p1", direction: "right", ratio: 0.5 })).rejects.toThrow(
    "pane_split_failed",
  );
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
  // ステータスと文言はルートがそのまま返す。ここが崩れると client は理由を失う。
  const rejected = {
    ok: false as const,
    status: 400 as const,
    error: "lines must be an integer between 1 and 4294967295",
  };
  for (const lines of ["0", "-1", "1.5", "abc", "4294967296"]) {
    expect(parseOutputQuery(new URLSearchParams({ lines }))).toEqual(rejected);
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
    value: { text: "hello", submit: false, attachments: [] },
  });
  expect(parseInputBody({ text: "hello", submit: true })).toEqual({
    ok: true,
    value: { text: "hello", submit: true, attachments: [] },
  });
});

test("parseInputBody rejects a missing or blank text", () => {
  const blank = {
    ok: false as const,
    status: 400 as const,
    error: "text must be a non-empty string",
  };
  const notText = { ok: false as const, status: 400 as const, error: "text must be a string" };

  expect(parseInputBody({})).toEqual(notText);
  expect(parseInputBody({ text: 42 })).toEqual(notText);
  expect(parseInputBody({ text: "" })).toEqual(blank);
  expect(parseInputBody({ text: "   " })).toEqual(blank);
  // 添付も無い空文字は送らないが、添付があれば本文は空でよい。
  expect(parseInputBody({ text: "   ", attachments: [] })).toEqual(blank);
});

test("parseInputBody accepts an empty text when images are attached", () => {
  const name = "pasted-20261103-120000.png";

  expect(parseInputBody({ text: "", attachments: [name] })).toEqual({
    ok: true,
    value: { text: "", submit: false, attachments: [name] },
  });
});

test("parseInputBody keeps at most four attachment names", () => {
  const name = "pasted-20261103-120000.png";

  expect(parseInputBody({ text: "hi", attachments: [name, name, name, name] }).ok).toBe(true);
  expect(parseInputBody({ text: "hi", attachments: [name, name, name, name, name] })).toEqual({
    ok: false,
    status: 400,
    error: "attachments must be at most 4",
  });
});

test("parseInputBody accepts any saved name, images or not", () => {
  expect(
    parseInputBody({
      text: "hi",
      attachments: ["pasted-20261103-120000.png", "report.zip", "My Report.xlsx"],
    }),
  ).toEqual({
    ok: true,
    value: {
      text: "hi",
      submit: false,
      attachments: ["pasted-20261103-120000.png", "report.zip", "My Report.xlsx"],
    },
  });
});

test("parseInputBody rejects an attachment name that is not a saved one", () => {
  const rejected = {
    ok: false as const,
    status: 400 as const,
    error: "attachments must be an array of attachment names",
  };

  expect(parseInputBody({ text: "hi", attachments: "pasted-20261103-120000.png" })).toEqual(
    rejected,
  );
  expect(parseInputBody({ text: "hi", attachments: ["../../etc/passwd"] })).toEqual(rejected);
  expect(parseInputBody({ text: "hi", attachments: [".env"] })).toEqual(rejected);
  expect(parseInputBody({ text: "hi", attachments: [42] })).toEqual(rejected);
});

test("parseInputBody rejects a body that is not an object", () => {
  const rejected = { ok: false as const, status: 400 as const, error: "body must be an object" };
  expect(parseInputBody(null)).toEqual(rejected);
  expect(parseInputBody(["hello"])).toEqual(rejected);
  expect(parseInputBody("hello")).toEqual(rejected);
});

test("exceedsTextLimit counts the bytes of the text it is given", () => {
  expect(exceedsTextLimit("a".repeat(16_384))).toBe(false);
  expect(exceedsTextLimit("a".repeat(16_385))).toBe(true);
  // 3 バイト文字はバイト数で数える。
  expect(exceedsTextLimit("あ".repeat(5_462))).toBe(true);
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

test("parseSplitBody trims the name and keeps a known agent", () => {
  expect(parseSplitBody({ name: "  実装  ", agent: "claude" })).toEqual({
    ok: true,
    value: { name: "実装", agent: "claude", model: null, effort: null },
  });
  expect(parseSplitBody({ name: "   ", agent: null })).toEqual({
    ok: true,
    value: { name: null, agent: null, model: null, effort: null },
  });
  expect(parseSplitBody({})).toEqual({
    ok: true,
    value: { name: null, agent: null, model: null, effort: null },
  });
});

test("parseSplitBody rejects an unknown agent, a non-string name, or an overlong name", () => {
  expect(parseSplitBody({ agent: "gemini" }).ok).toBe(false);
  expect(parseSplitBody({ name: 42 }).ok).toBe(false);
  expect(parseSplitBody({ name: "x".repeat(81) }).ok).toBe(false);
  expect(parseSplitBody(null).ok).toBe(false);
  expect(parseSplitBody([]).ok).toBe(false);
});

test.each(["pi", "codex", "opencode"])(
  "parseSplitBody accepts a provider-qualified model for %s",
  (agent) => {
    const model = { provider: "example", id: "family/beam-v1:latest" };
    expect(parseSplitBody({ agent, model })).toEqual({
      ok: true,
      value: { name: null, agent, model, effort: null },
    });
  },
);

test.each(["pi", "opencode"])(
  "parseSplitBody accepts namespaced model IDs starting with @ for %s",
  (agent) => {
    const model = { provider: "cloudflare-workers-ai", id: "@cf/meta/llama-3.2-3b-instruct" };
    expect(parseSplitBody({ agent, model })).toEqual({
      ok: true,
      value: { name: null, agent, model, effort: null },
    });
  },
);

test.each(["claude", null, undefined])("parseSplitBody rejects model overrides for %s", (agent) => {
  expect(parseSplitBody({ agent, model: { provider: "example", id: "beam" } }).ok).toBe(false);
  expect(parseSplitBody({ agent, model: null }).ok).toBe(true);
});

test.each(["pi", "codex", "opencode"])(
  "parseSplitBody accepts native effort values for an explicit %s model",
  (agent) => {
    const model = { provider: "example", id: "beam" };
    expect(parseSplitBody({ agent, model, effort: "じっくり review" })).toEqual({
      ok: true,
      value: { name: null, agent, model, effort: "じっくり review" },
    });
  },
);

test.each(["pi", "codex", "opencode", "claude", null, undefined])(
  "parseSplitBody rejects effort without an explicit model for %s",
  (agent) => {
    expect(parseSplitBody({ agent, effort: "high" }).ok).toBe(false);
    expect(parseSplitBody({ agent, model: null, effort: "high" }).ok).toBe(false);
    expect(parseSplitBody({ agent, effort: null }).ok).toBe(true);
  },
);

test.each(
  ["", " ", 1, {}, [], "high\n", "high\u0000", "x".repeat(129)].map((effort) => ({ effort })),
)("parseSplitBody rejects malformed effort: %j", ({ effort }) => {
  expect(
    parseSplitBody({ agent: "pi", model: { provider: "example", id: "beam" }, effort }).ok,
  ).toBe(false);
});

test.each([
  "beam",
  {},
  { provider: "example", id: "--help" },
  { provider: "example", id: "beam; touch file" },
  { provider: "example", id: "beam\nexit" },
  { provider: "example", id: "@cf/beam; touch file" },
  { provider: "example", id: "@cf/beam\n" },
  { provider: "example", id: "@cf/beam\r" },
  { provider: "example", id: "@cf/beam\u0000" },
  { provider: "example", id: "@cf/beam$(command)" },
])("parseSplitBody rejects malformed model identifiers: %j", (model) => {
  expect(parseSplitBody({ agent: "pi", model }).ok).toBe(false);
});

test("directory reads the requested pane's actual cwd without changing it", async () => {
  const { calls, call } = recordingCaller({
    "pane.get": { type: "pane_info", pane: { pane_id: "w1:p3", cwd: "/project" } },
  });
  const client = createPaneClient({ call });
  expect(await client.directory({ paneId: "w1:p3" })).toBe("/project");
  expect(calls[0]).toEqual({
    method: "pane.get",
    params: { pane_id: "w1:p3" },
    options: { path: undefined },
  });
});

test.each([
  { type: "ok", pane: { pane_id: "w1:p3", cwd: "/project" } },
  { type: "pane_info", pane: { pane_id: "w1:p4", cwd: "/project" } },
  { type: "pane_info", pane: { pane_id: "w1:p3", cwd: "relative" } },
  { type: "pane_info", pane: { pane_id: "w1:p3" } },
])("directory rejects an unknown or mismatched cwd: %j", async (reply) => {
  const { call } = recordingCaller({ "pane.get": reply });
  await expect(createPaneClient({ call }).directory({ paneId: "w1:p3" })).rejects.toThrow();
});

test("startAgent forwards the argument array without a shell command string", async () => {
  const { calls, call } = recordingCaller();
  await createPaneClient({ call }).startAgent({
    paneId: "w1:p3",
    kind: "pi",
    name: "hwc-w1-p3",
    args: ["--model", "example/beam"],
  });
  expect(calls[0]?.params).toEqual({
    pane_id: "w1:p3",
    kind: "pi",
    name: "hwc-w1-p3",
    timeout_ms: 30_000,
    args: ["--model", "example/beam"],
  });
});

test("agentNameForPane makes a name Herdr accepts even for a non-ASCII pane label", () => {
  expect(agentNameForPane("w1:p3")).toBe("hwc-w1-p3");
  expect(agentNameForPane("w1:p3")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(agentNameForPane("w1:p3").length).toBeLessThanOrEqual(32);
});

test("startAgent asks Herdr to start the kind and gives it a longer deadline", async () => {
  const { calls, call } = recordingCaller({ "agent.start": { type: "agent_started" } });
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  await client.startAgent({ paneId: "w1:p3", kind: "claude", name: "実装" });

  expect(calls).toEqual([
    {
      method: "agent.start",
      params: { pane_id: "w1:p3", kind: "claude", name: "実装", timeout_ms: 30_000 },
      options: { path: "/tmp/test.sock", timeoutMs: 35_000 },
    },
  ]);
});

test("startAgent waits for the shell that the split just created", async () => {
  let attempts = 0;
  const call = async <T>(): Promise<T> => {
    attempts += 1;
    if (attempts === 1) throw new HerdrError("agent_pane_busy", "not an available shell");
    return { type: "agent_started" } as T;
  };
  const client = createPaneClient({ call });

  await client.startAgent({ paneId: "w1:p3", kind: "pi", name: "hwc-w1-p3" });

  expect(attempts).toBe(2);
});

test("startAgent reports the failure so the route can keep the pane", async () => {
  const { call } = recordingCaller({
    "agent.start": new HerdrError("agent_spawn_failed", "not installed"),
  });
  const client = createPaneClient({ call });

  await expect(
    client.startAgent({ paneId: "w1:p3", kind: "codex", name: "codex" }),
  ).rejects.toThrow("agent_spawn_failed");
});

test("rename sets the pane label", async () => {
  const { calls, call } = recordingCaller({ "pane.rename": { type: "ok" } });
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  await client.rename({ paneId: "w1:p3", label: "実装" });

  expect(calls).toEqual([
    {
      method: "pane.rename",
      params: { pane_id: "w1:p3", label: "実装" },
      options: { path: "/tmp/test.sock" },
    },
  ]);
});

test("interrupt sends Ctrl+C to the foreground process", async () => {
  const { calls, call } = recordingCaller();
  await createPaneClient({ path: "/tmp/test.sock", call }).interrupt({ paneId: "w1:p2" });

  expect(calls).toEqual([
    {
      method: "pane.send_keys",
      params: { pane_id: "w1:p2", keys: ["C-c"] },
      options: { path: "/tmp/test.sock" },
    },
  ]);
});

test("process reads the pane and reports the deepest command", async () => {
  const { calls, call } = recordingCaller({
    "pane.process_info": {
      type: "pane_process_info",
      process_info: {
        pane_id: "w1:p2",
        shell_pid: 100,
        foreground_process_group_id: 300,
        foreground_processes: [
          { pid: 300, name: "bun", cmdline: "bun run dev" },
          { pid: 301, name: "bun", cmdline: "bun --watch src/server.ts" },
        ],
      },
    },
  });
  const client = createPaneClient({ path: "/tmp/test.sock", call });

  expect(await client.process({ paneId: "w1:p2" })).toEqual({
    running: true,
    command: "bun --watch src/server.ts",
    ports: [],
  });
  expect(calls).toEqual([
    {
      method: "pane.process_info",
      params: { pane_id: "w1:p2" },
      options: { path: "/tmp/test.sock" },
    },
  ]);
});

test("a pane whose foreground group is the shell is idle", () => {
  expect(
    parseProcessInfo(
      {
        type: "pane_process_info",
        process_info: {
          pane_id: "w1:p2",
          shell_pid: 100,
          foreground_process_group_id: 100,
          foreground_processes: [{ pid: 100, name: "bash", cmdline: "/bin/bash" }],
        },
      },
      "w1:p2",
    ),
  ).toEqual({ process: { running: false, command: null, ports: [] }, pids: [] });
});

test("a foreground group without a readable command still counts as running", () => {
  expect(
    parseProcessInfo(
      {
        type: "pane_process_info",
        process_info: {
          pane_id: "w1:p2",
          shell_pid: 100,
          foreground_process_group_id: 300,
          foreground_processes: [],
        },
      },
      "w1:p2",
    ),
  ).toEqual({ process: { running: true, command: null, ports: [] }, pids: [] });
});

test("process info for another pane or a malformed reply is ignored", () => {
  const reply = (paneId: string) => ({
    type: "pane_process_info",
    process_info: {
      pane_id: paneId,
      shell_pid: 100,
      foreground_process_group_id: 300,
      foreground_processes: [{ pid: 300, name: "bun", cmdline: "bun run dev" }],
    },
  });

  const idle = { process: { running: false, command: null, ports: [] }, pids: [] };
  expect(parseProcessInfo(reply("w1:p3"), "w1:p2")).toEqual(idle);
  expect(parseProcessInfo({ type: "pane_read" }, "w1:p2")).toEqual(idle);
  expect(parseProcessInfo(null, "w1:p2")).toEqual(idle);
});

test("a long command line is cut before it reaches the tab", () => {
  const command = `bun ${"x".repeat(400)}`;
  const parsed = parseProcessInfo(
    {
      type: "pane_process_info",
      process_info: {
        pane_id: "w1:p2",
        shell_pid: 100,
        foreground_process_group_id: 300,
        foreground_processes: [{ pid: 300, name: "bun", cmdline: command }],
      },
    },
    "w1:p2",
  );

  expect(parsed.process.command).toHaveLength(200);
});

test("parseStartBody keeps the agent and its model selection without a name", () => {
  expect(parseStartBody({ agent: "pi" })).toEqual({
    ok: true,
    value: { agent: "pi", model: null, effort: null },
  });
  const model = { provider: "example", id: "beam" };
  expect(parseStartBody({ agent: "codex", model, effort: "low" })).toEqual({
    ok: true,
    value: { agent: "codex", model, effort: "low" },
  });
});

test.each([
  { body: {} },
  { body: { agent: null } },
  { body: { agent: "gemini" } },
  { body: { name: "実装" } },
  { body: null },
  { body: [] },
  { body: "pi" },
])("parseStartBody requires a known agent and no shell choice: %j", ({ body }) => {
  expect(parseStartBody(body).ok).toBe(false);
});

test.each([
  { agent: "claude", model: { provider: "example", id: "beam" } },
  { agent: "pi", effort: "high" },
  { agent: "pi", model: { provider: "example", id: "beam" }, effort: "" },
])("parseStartBody reuses the model and effort rules: %j", (body) => {
  expect(parseStartBody(body).ok).toBe(false);
});

test("restartAgentName stays within the 32 characters Herdr accepts", () => {
  const name = restartAgentName("w80:p50", 0);
  expect(name).toMatch(/^[a-z0-9_-]{1,32}$/);
  expect(name.length).toBeLessThanOrEqual(32);
  // 同じペインで起動し直しても、前回と同じ名前にならない。
  expect(restartAgentName("w80:p50", 1)).not.toBe(name);
});

test("startAgent does not wait for a shell that is running a foreground command", async () => {
  let attempts = 0;
  const call = async <T>(): Promise<T> => {
    attempts += 1;
    throw new HerdrError("agent_pane_busy", "foreground command is running");
  };
  const client = createPaneClient({ call });

  await expect(
    client.startAgent({
      paneId: "w1:p1",
      kind: "pi",
      name: "hwc-w1-p1-0000",
      waitForShell: false,
    }),
  ).rejects.toThrow("agent_pane_busy");
  expect(attempts).toBe(1);
});
