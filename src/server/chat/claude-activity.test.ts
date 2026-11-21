import { beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionActivity } from "./contract";
import { createClaudeChatClient } from "./claude";

const SESSION = "6b1d7a44-2f3c-4e5b-8a19-7c2d3e4f5a6b";
const VERSION = "2.1.328";
const BASE = Date.parse("2026-02-01T09:00:00.000Z");
const NOW = 1_800_000_000_000;

let clock = 0;

type Entry = Record<string, unknown>;

function timestamp(): string {
  clock += 1;
  return new Date(BASE + clock * 1_000).toISOString();
}

function prompt(uuid: string, parentUuid: string | null, content?: unknown): Entry {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: timestamp(),
    version: VERSION,
    message: { role: "user", content: content ?? `確認 ${uuid} をお願いします。` },
  };
}

function user(uuid: string, parentUuid: string | null, content: unknown, extra: Entry = {}): Entry {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: timestamp(),
    version: VERSION,
    message: { role: "user", content },
    ...extra,
  };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  blocks: unknown[],
  extra: Entry = {},
): Entry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: timestamp(),
    version: VERSION,
    message: { id: `msg_${uuid}`, role: "assistant", model: "claude-sonnet-5-5", content: blocks },
    perTurnEffort: "high",
    ...extra,
  };
}

function apiRequest(id: string, extra: Entry = {}): Entry {
  return {
    type: "api-request",
    id,
    querySource: "repl_main_thread",
    timestamp: timestamp(),
    version: VERSION,
    ...extra,
  };
}

function toolResult(
  uuid: string,
  parentUuid: string | null,
  toolUseId: string | undefined,
  extra: Entry = {},
): Entry {
  const block: Entry = { type: "tool_result", content: "ok" };
  if (toolUseId !== undefined) block.tool_use_id = toolUseId;
  return user(uuid, parentUuid, [block], extra);
}

const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const toolUse = (id: string, name = "Read", input: unknown = { file_path: "docs/a.md" }) => ({
  type: "tool_use",
  id,
  name,
  input,
});

async function withTranscript<T>(
  entries: readonly Entry[],
  run: (client: ReturnType<typeof createClaudeChatClient>) => Promise<T>,
  options: {
    maxBytes?: number;
    live?: { tokPerSecond: number | null; at?: number } | null;
  } = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hwc-claude-activity-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const directory = join(root, "projects", "demo");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${SESSION}.jsonl`),
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
    const liveRoot = join(root, "live");
    if (options.live !== undefined) {
      await mkdir(liveRoot, { recursive: true });
      if (options.live !== null) {
        await writeFile(
          join(liveRoot, `${SESSION}.json`),
          JSON.stringify({
            v: 1,
            sessionId: SESSION,
            at: options.live.at ?? NOW,
            tokPerSecond: options.live.tokPerSecond,
          }),
        );
      }
    }
    return await run(
      createClaudeChatClient({
        now: () => NOW,
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        ...(options.live === undefined ? {} : { liveRoot }),
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function readActivity(
  entries: readonly Entry[],
  options: {
    maxBytes?: number;
    live?: { tokPerSecond: number | null; at?: number } | null;
  } = {},
): Promise<SessionActivity> {
  return withTranscript(entries, (client) => client.activity(SESSION), options);
}

beforeEach(() => {
  clock = 0;
});

test("an unanswered request is thinking while an answered one is not", async () => {
  const open = await readActivity([prompt("p1", null), apiRequest("api-1")]);
  expect(open).toEqual({
    prompt: "p1",
    activity: {
      phase: "thinking",
      text: "",
      tool: null,
      tools: 1,
      tokPerSecond: null,
      at: NOW,
    },
  });

  const answered = await readActivity([
    prompt("p1", null),
    apiRequest("api-1"),
    assistant("a1", "p1", [text("答えました。")], { requestRef: "api-1" }),
  ]);
  expect(answered).toEqual({ prompt: "p1", activity: null });
});

test("a live rate fills the thinking band", async () => {
  const state = await readActivity([prompt("p1", null), apiRequest("api-1")], {
    live: { tokPerSecond: 68.4 },
  });

  expect(state.activity).toMatchObject({ phase: "thinking", tokPerSecond: 68.4 });
});

test("a rate older than the poll window is dropped", async () => {
  const state = await readActivity([prompt("p1", null), apiRequest("api-1")], {
    live: { tokPerSecond: 68.4, at: NOW - 2_501 },
  });

  expect(state.activity?.tokPerSecond).toBeNull();
});

test("a tool wait does not carry the rate", async () => {
  const state = await readActivity(
    [
      prompt("p1", null),
      apiRequest("api-1"),
      assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1" }),
    ],
    { live: { tokPerSecond: 68.4 } },
  );

  expect(state.activity).toMatchObject({ phase: "tool", tokPerSecond: null });
});

test("without the mod's file the band has no rate", async () => {
  const state = await readActivity([prompt("p1", null), apiRequest("api-1")], { live: null });

  expect(state.activity?.tokPerSecond).toBeNull();
});

test("the direction comes from the last assistant text in the turn", async () => {
  const state = await readActivity([
    prompt("p1", null),
    apiRequest("api-1"),
    assistant("a1", "p1", [text("方針を確認しています。\n2 行目は出しません。")], {
      requestRef: "api-1",
    }),
    apiRequest("api-2"),
  ]);

  expect(state.activity).toMatchObject({
    phase: "thinking",
    text: "方針を確認しています。",
  });
});

test("thinking falls back to the tail of the last thinking body", async () => {
  const state = await readActivity([
    prompt("p1", null),
    apiRequest("api-1"),
    assistant("a1", "p1", [thinking(`${"い".repeat(200)}末尾`)]),
    apiRequest("api-2"),
  ]);

  const text = state.activity?.text ?? "";
  expect(text.endsWith("末尾")).toBe(true);
  expect(Array.from(text)).toHaveLength(90);
});

test("an API error ends the request instead of leaving it thinking", async () => {
  const state = await readActivity([
    prompt("p1", null),
    apiRequest("api-1"),
    assistant("e1", "p1", [text("Not logged in")], {
      requestRef: null,
      isApiErrorMessage: true,
      error: "authentication_failed",
    }),
  ]);

  expect(state).toEqual({ prompt: "p1", activity: null });
});

test("an assistant without a requestRef makes the answer undecidable", async () => {
  const state = await readActivity([
    prompt("p1", null),
    apiRequest("api-1"),
    assistant("a1", "p1", [text("どの要求への応答か分からない")]),
  ]);

  expect(state).toEqual({ prompt: "p1", activity: null });
});

test("old versions and empty start ids are undecidable", async () => {
  const cases: Entry[][] = [
    [prompt("p1", null), apiRequest("api-1", { version: "2.1.326" })],
    [prompt("p1", null), apiRequest("")],
    [prompt("p1", null), apiRequest("api-1", { version: "dev" })],
    [prompt("p1", null), assistant("a1", "p1", [toolUse("t1")], { version: "2.1.326" })],
    [prompt("p1", null), assistant("a1", "p1", [toolUse("")])],
    [prompt("p1", null), assistant("a1", "p1", [toolUse("t1")], { version: null })],
  ];
  for (const entries of cases) {
    expect(await readActivity(entries)).toEqual({ prompt: "p1", activity: null });
  }

  // 2.1.327 からは、応答の無い要求・結果の無いツールを未完了として出す。
  const boundary = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1", version: "2.1.327" }),
  ]);
  expect(boundary.activity).toMatchObject({ phase: "tool", tool: "Read" });
});

test("a tool shows its target on the first line and the direction on the second", async () => {
  const state = await readActivity([
    prompt("p1", null),
    apiRequest("api-1"),
    assistant("a1", "p1", [text("手順を確認しています。")], { requestRef: "api-1" }),
    assistant("a2", "a1", [toolUse("t1", "Read", { file_path: "docs/quickstart.md" })]),
  ]);

  expect(state).toEqual({
    prompt: "p1",
    activity: {
      phase: "tool",
      text: "quickstart.md\n手順を確認しています。",
      tool: "Read",
      tools: 1,
      tokPerSecond: null,
      at: NOW,
    },
  });
});

test("parallel tools keep the last unfinished one and their count", async () => {
  // 同じ API メッセージの tool_use は、別々の entry として同じ親に並ぶ。
  const state = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1", "Read", { file_path: "docs/a.md" })], {
      requestRef: "api-1",
    }),
    assistant("a2", "p1", [toolUse("t2", "Bash", { description: "テストを実行" })], {
      requestRef: "api-1",
    }),
    // 片方の結果が書かれ、その葉から辿ると a1 は枝の外へ出る。それでも未完了の t1 を落とさない。
    toolResult("r1", "a2", "t2"),
  ]);

  expect(state.activity).toMatchObject({
    phase: "tool",
    tool: "Read",
    tools: 1,
    text: "a.md",
  });

  const both = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1", "Read", { file_path: "docs/a.md" })], {
      requestRef: "api-1",
    }),
    assistant("a2", "p1", [toolUse("t2", "Bash", { description: "テストを実行" })], {
      requestRef: "api-1",
    }),
  ]);
  expect(both.activity).toMatchObject({ phase: "tool", tool: "Bash", tools: 2 });
});

test("a parallel tool_result that is off the branch still finishes its tool", async () => {
  const state = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1" }),
    assistant("a2", "p1", [toolUse("t2")], { requestRef: "api-1" }),
    toolResult("r1", "a1", "t1"),
    toolResult("r2", "a2", "t2"),
  ]);

  expect(state).toEqual({ prompt: "p1", activity: null });
});

test("a tool_result without an id makes the unfinished tool undecidable", async () => {
  const state = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1" }),
    toolResult("r1", "a1", undefined),
  ]);

  expect(state).toEqual({ prompt: "p1", activity: null });
});

test("sub-agent lines and sdk requests stay out of the step", async () => {
  const sidechainTool = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1", isSidechain: true }),
  ]);
  expect(sidechainTool).toEqual({ prompt: "p1", activity: null });

  const sidechainRequest = await readActivity([
    prompt("p1", null),
    apiRequest("api-1", { querySource: "sdk" }),
  ]);
  expect(sidechainRequest).toEqual({ prompt: "p1", activity: null });

  // サブエージェントの tool_result は本流のツールを終わらせない。
  const sidechainResult = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1" }),
    toolResult("r1", "a1", "t1", { isSidechain: true }),
  ]);
  expect(sidechainResult.activity).toMatchObject({ phase: "tool", tool: "Read" });
});

test("the turn starts at the last prompt, not at an interrupted earlier request", async () => {
  const state = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1" }),
    prompt("p2", "a1"),
  ]);

  expect(state).toEqual({ prompt: "p2", activity: null });
});

test("an image-only message is a prompt", async () => {
  const state = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1" }),
    user("p2", "a1", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
    ]),
    apiRequest("api-2"),
  ]);

  expect(state.prompt).toBe("p2");
  expect(state.activity).toMatchObject({ phase: "thinking" });
});

test("a rewound branch does not bring back the old request", async () => {
  const state = await readActivity([
    prompt("p1", null),
    apiRequest("api-1"),
    assistant("a1", "p1", [text("古い枝の答え")], { requestRef: "api-1" }),
    prompt("p2", "a1", "捨てる枝の続き"),
    apiRequest("api-2"),
    prompt("p3", "a1", "新しい枝の依頼"),
  ]);

  expect(state).toEqual({ prompt: "p3", activity: null });
});

test("a clipped window whose prompt fell outside is undecidable", async () => {
  const head = prompt("p1", null, `${"長い本文です。".repeat(400)}`);
  const tail = assistant("a1", "p1", [toolUse("t1")], { requestRef: "api-1" });
  const state = await readActivity([head, tail], {
    // 末尾の assistant 1 行だけが窓に入る大きさ。起点の prompt は窓の外へ落ちる。
    maxBytes: Buffer.byteLength(JSON.stringify(tail)) + 5,
  });

  expect(state).toEqual({ prompt: null, activity: null });
});

test("the direction keeps one line and at most 90 characters", async () => {
  const lines = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [text("1 行目です。\n2 行目は出しません。")], { requestRef: "api-1" }),
    apiRequest("api-2"),
  ]);
  expect(lines.activity?.text).toBe("1 行目です。");

  const long = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [text("あ".repeat(200))], { requestRef: "api-1" }),
    apiRequest("api-2"),
  ]);
  expect(Array.from(long.activity?.text ?? "")).toHaveLength(90);
});

test("a tool target is one line of at most 60 characters and never the command", async () => {
  const state = await readActivity([
    prompt("p1", null),
    assistant(
      "a1",
      "p1",
      [toolUse("t1", "bash", { description: "目的".repeat(80), command: "secret-cmd" })],
      { requestRef: "api-1" },
    ),
  ]);
  const target = state.activity?.text ?? "";
  expect(Array.from(target)).toHaveLength(60);
  expect(target).not.toContain("\n");
  expect(JSON.stringify(state.activity)).not.toContain("secret-cmd");

  // Bash の対象は description だけ。コマンドの本文しか無ければ対象を出さない。
  const noDescription = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1", "Bash", { command: "secret-cmd" })], {
      requestRef: "api-1",
    }),
  ]);
  expect(noDescription.activity).toMatchObject({ phase: "tool", tool: "Bash", text: "" });
});

test("a tool target folds newlines and keeps the file name only", async () => {
  const state = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1", "write", { file_path: "/tmp/demo/notes\n.md" })], {
      requestRef: "api-1",
    }),
  ]);

  expect(state.activity?.text).toBe("notes .md");
});

test("a tool without a target shows only the direction", async () => {
  const state = await readActivity([
    prompt("p1", null),
    apiRequest("api-1"),
    assistant("a1", "p1", [text("結果をまとめています。")], { requestRef: "api-1" }),
    assistant("a2", "a1", [toolUse("t1", "TodoWrite", { todos: [] })]),
  ]);

  expect(state.activity).toMatchObject({
    phase: "tool",
    tool: "TodoWrite",
    text: "結果をまとめています。",
  });
});

test("an interrupted tool-use marker is not the start of the next turn", async () => {
  const state = await readActivity([
    prompt("p1", null),
    assistant("a1", "p1", [toolUse("t1", "AskUserQuestion", { questions: [] })], {
      requestRef: "api-1",
    }),
    user("r1", "a1", [
      { type: "tool_result", tool_use_id: "t1", content: "rejected", is_error: true },
    ]),
    // Esc で質問を閉じたときの CLI の記録。利用者の発言ではない（docs/adr/claude-integration.md）。
    user("m1", "r1", "[Request interrupted by user for tool use]"),
  ]);

  expect(state).toEqual({ prompt: "p1", activity: null });
});
