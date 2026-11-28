import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeBranch,
  conversationBranch,
  parseTranscript,
  readTranscript,
} from "./claude-transcript";
import { ChatUnavailableError } from "./errors";

const AT = "2026-02-01T09:00:00.000Z";

function record(extra: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: AT, ...extra };
}

test("entries are indexed in file order and lines that cannot be read are dropped", () => {
  const raw = [
    JSON.stringify(record({ type: "user", uuid: "u1", message: { content: "本文" } })),
    '{"type":"assistant","uuid":"a0"',
    JSON.stringify([1, 2, 3]),
    // uuid の無い assistant は会話にも枝にも使えない。
    JSON.stringify(record({ type: "assistant", message: { content: [] } })),
    JSON.stringify(record({ type: "api-request", id: "api-1", querySource: "repl_main_thread" })),
    JSON.stringify(record({ type: "user", uuid: "u2", message: { content: "続き" } })),
  ].join("\n");

  const { entries, clipped } = parseTranscript(raw, false);

  expect(clipped).toBe(false);
  expect(entries.map((entry) => [entry.type, entry.uuid, entry.index])).toEqual([
    ["user", "u1", 0],
    ["api-request", null, 1],
    ["user", "u2", 2],
  ]);
});

test("content keeps only the blocks the conversation and the stage read", () => {
  const content = [
    { type: "text", text: "本文" },
    { type: "thinking", thinking: "考え" },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
    { type: "tool_result", tool_use_id: "t1", content: "x".repeat(1000), is_error: true },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "unknown", payload: "ignored" },
  ];
  const raw = JSON.stringify(
    record({ type: "assistant", uuid: "a1", message: { id: "msg-1", content } }),
  );

  const { entries } = parseTranscript(raw, false);

  expect(entries[0]?.message?.content).toEqual([
    { type: "text", text: "本文" },
    { type: "thinking", thinking: "考え" },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
    { type: "tool_result", toolUseId: "t1", isError: true },
    { type: "image" },
  ]);
});

test("a timestamp that cannot be read becomes zero", () => {
  const raw = JSON.stringify(
    record({ type: "user", uuid: "u1", message: { content: "本文" }, timestamp: "not a date" }),
  );

  const { entries } = parseTranscript(raw, false);

  expect(entries[0]?.at).toBe(0);
});

test("a compaction boundary cuts the branch used for waits but not the conversation", () => {
  const raw = [
    JSON.stringify(record({ type: "user", uuid: "u1", message: { content: "最初" } })),
    JSON.stringify(
      record({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [] } }),
    ),
    JSON.stringify(
      record({
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        parentUuid: null,
        logicalParentUuid: "a1",
        compactMetadata: { trigger: "auto", preTokens: 790_236 },
      }),
    ),
    JSON.stringify(
      record({
        type: "user",
        uuid: "s1",
        parentUuid: "b1",
        isCompactSummary: true,
        message: { content: "要約" },
      }),
    ),
    JSON.stringify(
      record({ type: "user", uuid: "u2", parentUuid: "s1", message: { content: "続き" } }),
    ),
  ].join("\n");

  const { entries } = parseTranscript(raw, false);

  expect(entries.find((entry) => entry.uuid === "b1")).toMatchObject({
    logicalParentUuid: "a1",
    preTokens: 790_236,
  });
  expect(activeBranch(entries).map((entry) => entry.uuid)).toEqual(["b1", "s1", "u2"]);
  expect(conversationBranch(entries).map((entry) => entry.uuid)).toEqual([
    "u1",
    "a1",
    "b1",
    "s1",
    "u2",
  ]);
});

// logicalParentUuid は圧縮の境界だけが持つ。他の行で辿り直すと枝を取り違えかねない。
test("a logical parent on another entry is not followed", () => {
  const raw = [
    JSON.stringify(record({ type: "user", uuid: "u1", message: { content: "最初" } })),
    JSON.stringify(
      record({
        type: "user",
        uuid: "u2",
        parentUuid: null,
        logicalParentUuid: "u1",
        message: { content: "続き" },
      }),
    ),
  ].join("\n");

  const { entries } = parseTranscript(raw, false);

  expect(conversationBranch(entries).map((entry) => entry.uuid)).toEqual(["u2"]);
});

test("a path that is not a file is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "hwc-claude-transcript-"));
  try {
    await expect(readTranscript(root, 1024)).rejects.toBeInstanceOf(ChatUnavailableError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
