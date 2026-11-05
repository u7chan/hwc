import { expect, test } from "bun:test";
import { withCodex } from "./codex";

const command = [
  process.execPath,
  "--eval",
  `
const { createInterface } = await import("node:readline");
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply({ method: "notice", params: {} });
    reply({ id: message.id, result: {} });
  } else if (message.method === "initialized") {
    initialized = true;
  } else if (message.params.mode === "hang") {
    await new Promise(() => {});
  } else if (message.params.mode === "exit") {
    process.exit(1);
  } else if (message.params.mode === "invalid") {
    process.stdout.write("not json\\n");
  } else if (message.params.mode === "large") {
    process.stdout.write("x".repeat(100_000));
  } else if (message.params.mode === "error") {
    reply({ id: message.id, error: { code: -32600, message: "/private/credential" } });
  } else {
    reply({ id: message.id, result: {
      initialized,
      method: message.method,
      params: message.params,
      directory: process.cwd(),
      inherited: Object.keys(process.env).filter(key => key.startsWith("HERDR_") || key === "CODEX_THREAD_ID"),
    } });
  }
}
`,
];

test("Codex initializes before reads, ignores notifications, and uses the requested directory", async () => {
  const result = await withCodex(
    "/tmp",
    async (request) => {
      await request("config/read", {});
      return request("model/list", { limit: 20 });
    },
    { command },
  );
  expect(result).toEqual({
    initialized: true,
    method: "model/list",
    params: { limit: 20 },
    directory: "/tmp",
    inherited: [],
  });
});

test.each(["exit", "invalid", "error"])("Codex %s failures reject the read", async (mode) => {
  await expect(
    withCodex(undefined, (request) => request("thread/read", { mode }), { command }),
  ).rejects.toThrow();
});

test("Codex RPC errors do not propagate upstream credentials or paths", async () => {
  await expect(
    withCodex(undefined, (request) => request("thread/read", { mode: "error" }), { command }),
  ).rejects.toThrow("codex request failed");
});

test("a silent Codex process is killed at the deadline", async () => {
  await expect(
    withCodex(undefined, (request) => request("thread/read", { mode: "hang" }), {
      command,
      timeoutMs: 250,
    }),
  ).rejects.toThrow("codex did not answer");
});

test("oversized Codex output without a newline is bounded", async () => {
  await expect(
    withCodex(undefined, (request) => request("thread/read", { mode: "large" }), {
      command,
      maxOutputBytes: 1024,
    }),
  ).rejects.toThrow("codex response is too large");
});

test("a missing Codex executable rejects instead of leaving a pending read", async () => {
  await expect(
    withCodex(undefined, (request) => request("thread/read", {}), {
      command: ["/nonexistent/hwc-codex"],
    }),
  ).rejects.toThrow();
});
