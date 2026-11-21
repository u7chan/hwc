import { expect, test } from "bun:test";
import {
  CLAUDE_LABELS_FAILURE_TTL_MS,
  CLAUDE_LABELS_TTL_MS,
  createClaudeModelLabels,
  parseClaudeModelLabels,
} from "./claude-model-labels";

function response(models: unknown[]): string {
  return [
    JSON.stringify({ type: "system", subtype: "ui_invalidate" }),
    JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: "model-labels", response: { models } },
    }),
  ].join("\n");
}

function model(value: string, displayName: string, resolvedModel = `claude-${value}`): unknown {
  return { value, displayName, resolvedModel };
}

test("reads only the aliases hwc offers, using the CLI's display name", () => {
  expect(
    parseClaudeModelLabels(
      response([
        model("default", "Default (recommended)", "claude-opus-5-5"),
        model("opus", "Opus 5.5", "claude-opus-5-5"),
        model("sonnet", "Sonnet 5.5", "claude-sonnet-5-5"),
        model("haiku", "Haiku 5.5", "claude-haiku-5-5"),
        model("fable", "Fable 5.2", "claude-fable-5-2"),
        model("claude-opus-5", "Opus 5", "claude-opus-5"),
        model("claude-fable-5-2[1m]", "Fable 5.2", "claude-fable-5-2"),
      ]),
    ),
  ).toEqual({
    "claude/opus": "Opus 5.5",
    "claude/sonnet": "Sonnet 5.5",
    "claude/haiku": "Haiku 5.5",
    "claude/fable": "Fable 5.2",
  });
});

test("derives the version when the CLI's display name has none", () => {
  expect(
    parseClaudeModelLabels(
      response([
        model("fable", "Fable", "claude-fable-5-2"),
        model("opus", "Opus", "claude-opus-5-5"),
      ]),
    ),
  ).toEqual({ "claude/fable": "Fable 5.2", "claude/opus": "Opus 5.5" });
});

test("keeps an unreadable display name out of the labels", () => {
  expect(
    parseClaudeModelLabels(
      response([
        model("opus", "Opus\u0000", "claude-opus-5-5"),
        model("sonnet", "Sonnet", "not-a-claude-id"),
      ]),
    ),
  ).toEqual({ "claude/opus": "Opus 5.5" });
});

test("returns null when the control response has no model list", () => {
  expect(parseClaudeModelLabels("")).toBeNull();
  expect(parseClaudeModelLabels("not json")).toBeNull();
  expect(
    parseClaudeModelLabels(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "error", request_id: "model-labels" },
      }),
    ),
  ).toBeNull();
});

test("caches a successful read for five minutes and refreshes when the CLI changes", async () => {
  let now = 1_000;
  let key = "cli-a";
  let calls = 0;
  const reader = createClaudeModelLabels({
    now: () => now,
    key: async () => key,
    run: async () => {
      calls += 1;
      return response([model("opus", "Opus 5.5")]);
    },
  });

  expect(await reader.read()).toEqual({ "claude/opus": "Opus 5.5" });
  expect(calls).toBe(1);
  expect(await reader.read()).toEqual({ "claude/opus": "Opus 5.5" });
  expect(calls).toBe(1);

  now += CLAUDE_LABELS_TTL_MS - 1;
  expect(await reader.read()).toEqual({ "claude/opus": "Opus 5.5" });
  expect(calls).toBe(1);

  now += 1;
  expect(await reader.read()).toEqual({ "claude/opus": "Opus 5.5" });
  expect(calls).toBe(2);

  key = "cli-b";
  expect(await reader.read()).toEqual({ "claude/opus": "Opus 5.5" });
  expect(calls).toBe(3);
});

test("caches a failure briefly so a broken CLI is not started on every read", async () => {
  let now = 1_000;
  let calls = 0;
  const reader = createClaudeModelLabels({
    now: () => now,
    key: async () => "cli",
    run: async () => {
      calls += 1;
      throw new Error("not available");
    },
  });

  expect(await reader.read()).toBeNull();
  expect(calls).toBe(1);
  expect(await reader.read()).toBeNull();
  expect(calls).toBe(1);

  now += CLAUDE_LABELS_FAILURE_TTL_MS;
  expect(await reader.read()).toBeNull();
  expect(calls).toBe(2);
});

test("shares one read when several requests arrive together", async () => {
  let calls = 0;
  let finish!: (value: string) => void;
  const reader = createClaudeModelLabels({
    key: async () => "cli",
    run: () => {
      calls += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });

  const first = reader.read();
  const second = reader.read();
  await Bun.sleep(0);
  expect(calls).toBe(1);
  finish(response([model("opus", "Opus 5.5")]));
  expect(await first).toEqual({ "claude/opus": "Opus 5.5" });
  expect(await second).toEqual({ "claude/opus": "Opus 5.5" });
  expect(calls).toBe(1);
});
