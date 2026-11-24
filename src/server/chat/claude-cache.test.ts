import { expect, test } from "bun:test";
import { promptCacheExpiry } from "./claude-cache";
import { activeBranch, parseTranscript } from "./claude-transcript";

const BASE = Date.parse("2026-02-01T09:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function at(offset: number): string {
  return new Date(BASE + offset).toISOString();
}

function user(uuid: string, parentUuid: string | null, offset: number) {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: at(offset),
    message: { role: "user", content: "続けてください。" },
  };
}

function request(id: string, offset: number, extra: Record<string, unknown> = {}) {
  return {
    type: "api-request",
    id,
    querySource: "repl_main_thread",
    timestamp: at(offset),
    version: "2.1.328",
    ...extra,
  };
}

function reply(uuid: string, parentUuid: string, requestRef: string, offset: number) {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: at(offset),
    message: {
      id: `msg-${uuid}`,
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "返事です。" }],
      stop_reason: "end_turn",
      usage: {
        cache_creation_input_tokens: 12_000,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 12_000, ephemeral_5m_input_tokens: 0 },
      },
    },
    requestRef,
  };
}

function expiryOf(records: readonly unknown[]): number | null {
  const { entries } = parseTranscript(
    records.map((line) => JSON.stringify(line)).join("\n"),
    false,
  );
  return promptCacheExpiry(entries, activeBranch(entries));
}

test("a completed one-hour write sets the expiry from the request time", () => {
  expect(
    expiryOf([user("u1", null, 0), request("api-1", 1_000), reply("a1", "u1", "api-1", 2_000)]),
  ).toBe(BASE + 1_000 + HOUR_MS);
});

test("a request whose timestamp cannot be read does not start an expiry", () => {
  expect(
    expiryOf([
      user("u1", null, 0),
      request("api-1", 0, { timestamp: "not a date" }),
      reply("a1", "u1", "api-1", 2_000),
    ]),
  ).toBeNull();
});
