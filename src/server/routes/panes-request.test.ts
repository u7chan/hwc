import { expect, test } from "bun:test";
import {
  isOpencodeCommand,
  parseInputBody,
  parseOutputQuery,
  parseSplitBody,
  parseStartBody,
} from "./panes-request";

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

test("isOpencodeCommand matches only the commands hwc sends", () => {
  expect(isOpencodeCommand("/new", 0)).toBe(true);
  expect(isOpencodeCommand("/new ", 0)).toBe(true);
  expect(isOpencodeCommand(" /new", 0)).toBe(false);
  expect(isOpencodeCommand("/compact", 0)).toBe(true);
  expect(isOpencodeCommand("/compact focus on the API", 0)).toBe(true);
  expect(isOpencodeCommand("/compact\n続きをまとめる", 0)).toBe(false);
  expect(isOpencodeCommand("/new\nhello", 0)).toBe(false);
  expect(isOpencodeCommand("/home/user", 0)).toBe(false);
  // 添付の注記が後ろに付く本文はコマンドにならない。
  expect(isOpencodeCommand("/compact", 1)).toBe(false);
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

test("parseInputBody rejects a submit that is not a boolean", () => {
  expect(parseInputBody({ text: "hello", submit: "yes" })).toEqual({
    ok: false,
    status: 400,
    error: "submit must be a boolean",
  });
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

test.each(["pi", "claude", "codex", "opencode"])(
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

test.each([null, undefined])("parseSplitBody rejects model overrides for %s", (agent) => {
  expect(parseSplitBody({ agent, model: { provider: "example", id: "beam" } }).ok).toBe(false);
  expect(parseSplitBody({ agent, model: null }).ok).toBe(true);
});

test.each(["pi", "claude", "codex", "opencode"])(
  "parseSplitBody accepts native effort values for an explicit %s model",
  (agent) => {
    const model = { provider: "example", id: "beam" };
    expect(parseSplitBody({ agent, model, effort: "じっくり review" })).toEqual({
      ok: true,
      value: { name: null, agent, model, effort: "じっくり review" },
    });
  },
);

test.each(["pi", "codex", "opencode", null, undefined])(
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

test("parseStartBody keeps the agent and its model selection without a name", () => {
  expect(parseStartBody({ agent: "pi" })).toEqual({
    ok: true,
    value: { agent: "pi", model: null, effort: null, waitForShell: false },
  });
  const model = { provider: "example", id: "beam" };
  expect(parseStartBody({ agent: "codex", model, effort: "low" })).toEqual({
    ok: true,
    value: { agent: "codex", model, effort: "low", waitForShell: false },
  });
  const alias = { provider: "claude", id: "opus" };
  expect(parseStartBody({ agent: "claude", model: alias, effort: "high" })).toEqual({
    ok: true,
    value: { agent: "claude", model: alias, effort: "high", waitForShell: false },
  });
  // 分割直後のペインだけ、シェルの準備待ちを含める。
  expect(parseStartBody({ agent: "pi", waitForShell: true })).toEqual({
    ok: true,
    value: { agent: "pi", model: null, effort: null, waitForShell: true },
  });
});

test.each([
  { body: {} },
  { body: { agent: null } },
  { body: { agent: "gemini" } },
  { body: { name: "実装" } },
  { body: { agent: "pi", waitForShell: "yes" } },
  { body: null },
  { body: [] },
  { body: "pi" },
])("parseStartBody requires a known agent and no shell choice: %j", ({ body }) => {
  expect(parseStartBody(body).ok).toBe(false);
});

test.each([
  { agent: "pi", effort: "high" },
  { agent: "pi", model: { provider: "example", id: "beam" }, effort: "" },
])("parseStartBody reuses the model and effort rules: %j", (body) => {
  expect(parseStartBody(body).ok).toBe(false);
});
