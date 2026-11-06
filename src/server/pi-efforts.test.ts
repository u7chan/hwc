import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPiEfforts, parsePiEfforts } from "./pi-efforts";

const model = { provider: "example", id: "beam" };
const reply = (command: string, data: unknown) =>
  JSON.stringify({ type: "response", command, success: true, data });
const state = reply("get_state", { model: { ...model, reasoning: true } });

test("Pi effort choices come from the selected model's RPC, preserving native order and names", () => {
  const levels = ["minimal", "high", "xhigh", "max", "high", "future-level"];
  expect(
    parsePiEfforts(`${state}\n${reply("get_available_thinking_levels", { levels })}`, model),
  ).toEqual(["minimal", "high", "xhigh", "max", "future-level"]);
});

test("Pi models without reasoning do not offer an off-only effort control", () => {
  expect(
    parsePiEfforts(
      [
        reply("get_state", { model: { ...model, reasoning: false } }),
        reply("get_available_thinking_levels", { levels: ["off"] }),
      ].join("\n"),
      model,
    ),
  ).toEqual([]);
});

test.each([
  { ...model, id: "other" },
  { ...model, provider: "other" },
])("Pi fuzzy selection cannot supply efforts for a different model: %j", (selected) => {
  expect(() =>
    parsePiEfforts(
      `${state}\n${reply("get_available_thinking_levels", { levels: ["high"] })}`,
      selected,
    ),
  ).toThrow("requested model");
});

test.each([
  "not json",
  state,
  `${state}\n${reply("get_available_thinking_levels", { levels: null })}`,
  `${state}\n${reply("get_available_thinking_levels", { levels: ["high", null] })}`,
  `${state}\n${reply("get_available_thinking_levels", { levels: ["high\nexit"] })}`,
  reply("get_state", { model }),
  JSON.stringify({
    type: "response",
    command: "get_state",
    success: false,
    error: "/private/path",
  }),
])("unavailable or malformed Pi efforts do not fabricate choices: %j", (text) => {
  expect(() => parsePiEfforts(text, model)).toThrow();
});

async function withFakePi(run: (command: string[], directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "hwc-pi-efforts-"));
  const path = join(root, "pi.ts");
  await writeFile(
    path,
    `
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.slice(0, 5).join(" ") !== "--offline --mode rpc --no-session --model") process.exit(2);
if (Object.keys(process.env).some(key => key.startsWith("HERDR_"))) process.exit(3);
if (process.cwd() !== import.meta.dirname) process.exit(4);
const id = args[5].slice("example/".length);
if (id === "hang") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
if (id === "large") { process.stdout.write("x".repeat(100_000)); process.exit(0); }
if (id === "exit") process.exit(5);
const commands = [];
for await (const line of createInterface({ input: process.stdin })) commands.push(JSON.parse(line).type);
if (commands.join(" ") !== "get_state get_available_thinking_levels") process.exit(6);
for (const command of commands) {
  const data = command === "get_state"
    ? { model: { provider: "example", id, reasoning: true } }
    : { levels: ["low", "max"] };
  console.log(JSON.stringify({ type: "response", command, success: true, data }));
}
`,
  );
  try {
    await run([process.execPath, path], root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Pi effort discovery is offline, ephemeral, read-only, and uses the requested directory", async () => {
  await withFakePi(async (command, directory) => {
    expect(await loadPiEfforts(directory, model, { command })).toEqual(["low", "max"]);
  });
});

test("a silent Pi process is killed at the effort lookup deadline", async () => {
  await withFakePi(async (command, directory) => {
    await expect(
      loadPiEfforts(directory, { ...model, id: "hang" }, { command, timeoutMs: 250 }),
    ).rejects.toThrow("lookup failed");
  });
});

test("oversized Pi effort output without a newline is bounded", async () => {
  await withFakePi(async (command, directory) => {
    await expect(
      loadPiEfforts(directory, { ...model, id: "large" }, { command, maxOutputBytes: 1024 }),
    ).rejects.toThrow("too large");
  });
});

test("a failed or missing Pi executable rejects effort discovery", async () => {
  await withFakePi(async (command, directory) => {
    await expect(loadPiEfforts(directory, { ...model, id: "exit" }, { command })).rejects.toThrow();
    await expect(
      loadPiEfforts(directory, model, { command: [join(directory, "missing")] }),
    ).rejects.toThrow();
  });
});
