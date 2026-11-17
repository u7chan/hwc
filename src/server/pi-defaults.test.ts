import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiDefaults, loadPiDefaults, parsePiDefaults } from "./pi-defaults";

const reply = (data: unknown) =>
  JSON.stringify({ type: "response", command: "get_state", success: true, data });

test("the default model and effort come from pi's startup state", () => {
  expect(
    parsePiDefaults(
      reply({ model: { provider: "example", id: "beam", reasoning: true }, thinkingLevel: "high" }),
    ),
  ).toEqual({ model: "beam", effort: "high" });
});

test("a model without reasoning has no effort", () => {
  expect(
    parsePiDefaults(
      reply({ model: { provider: "example", id: "beam", reasoning: false }, thinkingLevel: "off" }),
    ),
  ).toEqual({ model: "beam", effort: null });
});

test("an unknown thinking level is left out instead of guessed", () => {
  expect(
    parsePiDefaults(reply({ model: { provider: "example", id: "beam" }, thinkingLevel: null })),
  ).toEqual({ model: "beam", effort: null });
});

test.each([
  "not json",
  JSON.stringify({ type: "response", command: "get_state", success: false, error: "/private" }),
  reply({}),
  reply({ model: { provider: "example" }, reasoning: true }),
  reply({ model: { provider: "example", id: "--help" } }),
  JSON.stringify({ type: "response", command: "get_state", success: true, data: null }),
])("unreadable startup state does not invent a default: %j", (text) => {
  expect(() => parsePiDefaults(text)).toThrow();
});

test("the defaults are read once per pane and only after its launch expects them", async () => {
  const seen: string[] = [];
  const settings = createPiDefaults(async (directory) => {
    seen.push(directory);
    return { model: "beam", effort: "high" };
  });

  expect(await settings.read("w1:p1", "/project")).toBeNull();
  expect(seen).toEqual([]);

  settings.remember("w1:p1");
  const [first, second] = await Promise.all([
    settings.read("w1:p1", "/project"),
    settings.read("w1:p1", "/project"),
  ]);
  expect(first).toEqual({ model: "beam", effort: "high" });
  expect(second).toEqual(first);
  expect(await settings.read("w1:p1", "/project")).toEqual(first);
  expect(seen).toEqual(["/project"]);
});

test("a delayed lookup from a previous launch cannot replace the new launch", async () => {
  const resolves: ((value: { model: string; effort: string | null }) => void)[] = [];
  let loads = 0;
  const settings = createPiDefaults(() => {
    loads += 1;
    return new Promise((resolve) => resolves.push(resolve));
  });

  settings.remember("w1:p1");
  const previous = settings.read("w1:p1", "/previous");
  settings.forget("w1:p1");
  settings.remember("w1:p1");
  const current = settings.read("w1:p1", "/current");

  resolves[1]!({ model: "beam-current", effort: "low" });
  await expect(current).resolves.toEqual({ model: "beam-current", effort: "low" });
  resolves[0]!({ model: "beam-previous", effort: "high" });
  await expect(previous).resolves.toEqual({ model: "beam-previous", effort: "high" });

  expect(await settings.read("w1:p1", "/another")).toEqual({
    model: "beam-current",
    effort: "low",
  });
  expect(loads).toBe(2);
});

test("a stale rejection does not clear the current launch's pending lookup", async () => {
  const settles: {
    resolve: (value: { model: string; effort: string | null }) => void;
    reject: (error: Error) => void;
  }[] = [];
  let loads = 0;
  const settings = createPiDefaults(() => {
    loads += 1;
    return new Promise((resolve, reject) => settles.push({ resolve, reject }));
  });

  settings.remember("w1:p1");
  const previous = settings.read("w1:p1", "/previous");
  settings.forget("w1:p1");
  settings.remember("w1:p1");
  const current = settings.read("w1:p1", "/current");
  void settings.read("w1:p1", "/current");

  settles[0]!.reject(new Error("late failure"));
  await previous.catch(() => null);
  void settings.read("w1:p1", "/current");
  expect(loads).toBe(2);

  settles[1]!.resolve({ model: "beam-current", effort: "low" });
  await expect(current).resolves.toEqual({ model: "beam-current", effort: "low" });
});

test("a failed lookup is not kept and the next read retries", async () => {
  let calls = 0;
  const settings = createPiDefaults(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Pi default model lookup failed");
    return { model: "beam", effort: "high" };
  });
  settings.remember("w1:p1");

  await expect(settings.read("w1:p1", "/project")).rejects.toThrow();
  expect(await settings.read("w1:p1", "/project")).toEqual({ model: "beam", effort: "high" });
  expect(calls).toBe(2);
});

test("a recorded session model drops the resolved value and keeps the launch record", async () => {
  let calls = 0;
  const settings = createPiDefaults(async () => {
    calls += 1;
    return { model: "beam", effort: "high" };
  });

  settings.remember("w1:p1");
  expect(await settings.read("w1:p1", "/project")).toEqual({ model: "beam", effort: "high" });
  // 会話にモデルが無い間の読み直しは、解決済みの値を使う。
  settings.dropResolved("w1:p1", null);
  expect(await settings.read("w1:p1", "/project")).toEqual({ model: "beam", effort: "high" });
  expect(calls).toBe(1);
  // 会話にモデルが載ったら捨てる。/new で空に戻ったときは取り直す。
  settings.dropResolved("w1:p1", "beam");
  expect(await settings.read("w1:p1", "/project")).toEqual({ model: "beam", effort: "high" });
  expect(calls).toBe(2);

  settings.forget("w1:p1");
  expect(await settings.read("w1:p1", "/project")).toBeNull();
});

async function withFakePi(run: (command: string[], directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "hwc-pi-defaults-"));
  const path = join(root, "pi.ts");
  await writeFile(
    path,
    `
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.join(" ") !== "--offline --mode rpc --no-session") process.exit(2);
if (Object.keys(process.env).some(key => key.startsWith("HERDR_"))) process.exit(3);
if (process.cwd() !== import.meta.dirname) process.exit(4);
const commands = [];
for await (const line of createInterface({ input: process.stdin })) commands.push(JSON.parse(line).type);
if (commands.join(" ") !== "get_state") process.exit(6);
console.log(JSON.stringify({
  type: "response",
  command: "get_state",
  success: true,
  data: { model: { provider: "example", id: "beam", reasoning: true }, thinkingLevel: "high" },
}));
`,
  );
  try {
    await run([process.execPath, path], root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Pi default discovery is offline, ephemeral, and uses the pane directory", async () => {
  await withFakePi(async (command, directory) => {
    expect(await loadPiDefaults(directory, { command })).toEqual({ model: "beam", effort: "high" });
  });
});

test("a failed Pi executable has no default", async () => {
  await withFakePi(async (command, directory) => {
    await expect(
      loadPiDefaults(directory, { command: [join(directory, "missing")] }),
    ).rejects.toThrow();
  });
});
