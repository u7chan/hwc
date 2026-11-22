import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySwitchHook,
  clearSwitch,
  readDone,
  SWITCH_ALLOW_TTL_MS,
  switchRoot,
  writeAllow,
} from "./claude-switch";

const SESSION = "86b91da4-c33e-4956-b5e7-9284497a0a2c";
const NOW = 1_000_000;

let root: string;

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), "hwc-claude-switch-")), "model-switch");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

// CLI 2.1.330 が PreModelSwitch / PostModelSwitch に渡す入力（実機で採った形）。
const pre = (overrides: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  hook_event_name: "PreModelSwitch",
  from_model: "claude-haiku-5-5",
  to_model: "claude-opus-5-5",
  requested_model: "opus",
  source: "command",
  context_tokens: 39905,
  prompt_cache_warm: true,
  cache_ttl: "1h",
  ...overrides,
});
const post = (overrides: Record<string, unknown> = {}) =>
  pre({ hook_event_name: "PostModelSwitch", ...overrides });

describe("PreModelSwitch", () => {
  test("allows the command hwc asked for, so the confirmation dialog stays closed", async () => {
    await writeAllow(root, SESSION, "opus", NOW);

    const output = await applySwitchHook(root, pre(), NOW + 100);

    expect(JSON.parse(output ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreModelSwitch",
        permissionDecision: "allow",
        permissionDecisionReason: "Confirmed in hwc",
      },
    });
  });

  test("allows the CLI's second call for the same command, whose to_model differs", async () => {
    await writeAllow(root, SESSION, "opus", NOW);

    const output = await applySwitchHook(
      root,
      pre({ from_model: "claude-opus-5-5", to_model: "claude-sonnet-5-5" }),
      NOW + 100,
    );

    expect(output).not.toBeNull();
  });

  test("leaves a switch hwc did not ask for to the CLI's own confirmation", async () => {
    // 印が無い（端末で打った `/model`）。
    expect(await applySwitchHook(root, pre(), NOW)).toBeNull();

    // 印は別のモデル。
    await writeAllow(root, SESSION, "sonnet", NOW);
    expect(await applySwitchHook(root, pre(), NOW)).toBeNull();
  });

  test.each(["picker", "auto", "sdk"])("does not allow a switch from %s", async (source) => {
    await writeAllow(root, SESSION, "opus", NOW);
    expect(await applySwitchHook(root, pre({ source }), NOW)).toBeNull();
  });

  test("does not allow once the mark has expired", async () => {
    await writeAllow(root, SESSION, "opus", NOW);
    expect(await applySwitchHook(root, pre(), NOW + SWITCH_ALLOW_TTL_MS + 1)).toBeNull();
  });

  test("does not use another session's mark", async () => {
    await writeAllow(root, "another-session", "opus", NOW);
    expect(await applySwitchHook(root, pre(), NOW)).toBeNull();
  });
});

describe("PostModelSwitch", () => {
  test("records the resolved model and consumes the mark", async () => {
    await writeAllow(root, SESSION, "opus", NOW);

    expect(await applySwitchHook(root, post(), NOW + 500)).toBeNull();

    expect(await readDone(root, SESSION, NOW)).toEqual({
      v: 1,
      sessionId: SESSION,
      at: NOW + 500,
      model: "claude-opus-5-5",
      requested: "opus",
    });
    // 印は消える。同じ印で次の切り替えを許可しない。
    expect(await applySwitchHook(root, pre(), NOW + 600)).toBeNull();
  });

  test("records nothing for a switch hwc did not ask for", async () => {
    expect(await applySwitchHook(root, post(), NOW)).toBeNull();
    expect(await readDone(root, SESSION, 0)).toBeNull();
  });

  test("ignores a record from before the switch that is being waited for", async () => {
    await writeAllow(root, SESSION, "opus", NOW);
    await applySwitchHook(root, post(), NOW + 500);

    expect(await readDone(root, SESSION, NOW + 501)).toBeNull();
  });
});

describe("files", () => {
  test("are private to the owner", async () => {
    await writeAllow(root, SESSION, "opus", NOW);

    expect((await stat(join(root, `${SESSION}.allow.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  test("are removed by clearSwitch, both kinds", async () => {
    await writeAllow(root, SESSION, "opus", NOW);
    await applySwitchHook(root, post(), NOW);
    await writeAllow(root, SESSION, "haiku", NOW);

    await clearSwitch(root, SESSION);

    expect(await readdir(root)).toEqual([]);
  });

  test("never take a session id that can leave the directory", async () => {
    await expect(writeAllow(root, "../escape", "opus", NOW)).rejects.toThrow();
    expect(await applySwitchHook(root, pre({ session_id: "../escape" }), NOW)).toBeNull();
  });

  test("a damaged or oversized file counts as no mark", async () => {
    await writeAllow(root, SESSION, "opus", NOW);
    await writeFile(join(root, `${SESSION}.allow.json`), "{not json");
    expect(await applySwitchHook(root, pre(), NOW)).toBeNull();

    await writeFile(join(root, `${SESSION}.allow.json`), " ".repeat(5000));
    expect(await applySwitchHook(root, pre(), NOW)).toBeNull();
  });
});

test("the root is a sibling of the pending and live directories", () => {
  expect(switchRoot("/var/state/hwc")).toBe("/var/state/hwc/claude/model-switch");
});
