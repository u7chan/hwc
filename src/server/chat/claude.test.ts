import { beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeChatClient } from "./claude";
import { LIVE_TTL_MS } from "./claude-live";
import { SIDECAR_TTL_MS } from "./claude-sidecar";
import type { ChatPending } from "./contract";
import { ChatUnavailableError } from "./errors";
import { MAX_CHAT_MESSAGES } from "./limit";

const SESSION = "5f0c2f6e-8b1a-4c0d-9d7e-2a6f1c3b4d5e";
const MODEL = "claude-sonnet-5-5";
const BASE = Date.parse("2026-01-01T09:00:00.000Z");

let clock = 0;

function timestamp(): string {
  clock += 1;
  return new Date(BASE + clock * 1_000).toISOString();
}

function user(
  uuid: string,
  parentUuid: string | null,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: timestamp(),
    message: { role: "user", content },
    ...extra,
  };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  messageId: string | null,
  content: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: timestamp(),
    message: { id: messageId, role: "assistant", model: MODEL, content },
    perTurnEffort: "xhigh",
    ...extra,
  };
}

const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const toolUse = (id: string) => ({
  type: "tool_use",
  id,
  name: "Read",
  input: { file_path: "/a" },
});
const tool = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const question = (
  text: string,
  options: string[],
  extra: { header?: string; multiSelect?: boolean } = {},
) => ({
  question: text,
  header: extra.header ?? "確認",
  multiSelect: extra.multiSelect ?? false,
  options: options.map((label) => ({ label, description: `${label} の説明` })),
});
const askUse = (id: string, questions: unknown) => tool(id, "AskUserQuestion", { questions });

const HOUR_MS = 60 * 60 * 1000;
const SYNTHETIC = "<synthetic>";

function request(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "api-request",
    id,
    querySource: "repl_main_thread",
    timestamp: timestamp(),
    version: "2.1.328",
    ...extra,
  };
}

// 実機の message.usage のうち、キャッシュの判定に使う項目だけを持つ形。
function cacheUsage(oneHour: number, fiveMinutes = 0, read = 0) {
  return {
    cache_creation_input_tokens: oneHour + fiveMinutes,
    cache_read_input_tokens: read,
    cache_creation: {
      ephemeral_1h_input_tokens: oneHour,
      ephemeral_5m_input_tokens: fiveMinutes,
    },
  };
}

function reply(
  uuid: string,
  parentUuid: string | null,
  messageId: string,
  requestRef: string | null,
  cache: unknown,
  extra: {
    model?: string;
    effort?: string | null;
    blocks?: unknown[];
    entry?: Record<string, unknown>;
  } = {},
) {
  const blocks = extra.blocks ?? [text("返事です。")];
  return assistant(uuid, parentUuid, messageId, blocks, {
    ...(requestRef === null ? {} : { requestRef }),
    ...(extra.effort === undefined ? {} : { perTurnEffort: extra.effort }),
    ...extra.entry,
    message: {
      id: messageId,
      role: "assistant",
      model: extra.model ?? MODEL,
      content: blocks,
      stop_reason: "end_turn",
      ...(cache === null ? {} : { usage: cache }),
    },
  });
}

// 実物と同じく、圧縮の境界は新しい枝の根になる。parentUuid は null で、元の枝は
// logicalParentUuid にだけ残る。待ちと段階はこの枝で切り、会話だけ辿り直す。
function boundary(logicalParentUuid: string | null, compactMetadata?: unknown) {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: "boundary-1",
    parentUuid: null,
    logicalParentUuid,
    timestamp: timestamp(),
    version: "2.1.328",
    ...(compactMetadata === undefined ? {} : { compactMetadata }),
  };
}

// 実物の要約は、モデル向けの定型文と内部の注記から始まる。
const SUMMARY_RAW = [
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
  "",
  "<system-reminder>",
  "<tools-used-before-summary>Bash, Read</tools-used-before-summary>",
  "</system-reminder>",
  "Summary:",
  "1. 最初の依頼",
].join("\n");

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hwc-claude-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeTranscript(
  root: string,
  entries: readonly unknown[],
  project = "demo",
): Promise<string> {
  const directory = join(root, "projects", project);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${SESSION}.jsonl`);
  await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}

beforeEach(() => {
  clock = 0;
});

test("assistant text is joined per API message in file order and stamped with the first entry", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "最初の質問");
    const head = assistant("a1", "u1", "msg_1", [thinking("考え中")]);
    const body = assistant("a2", "a1", "msg_1", [text("最初の段落です。")]);
    const tool = assistant("a3", "a2", "msg_1", [toolUse("t1")]);
    const result = user("r1", "a3", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
    const rest = assistant("a4", "r1", "msg_1", [text("続きの段落です。")]);
    const answer = assistant("a5", "a4", "msg_2", [text("最後の答えです。")], {
      message: {
        id: "msg_2",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [text("最後の答えです。")],
      },
      perTurnEffort: "low",
    });
    await writeTranscript(root, [first, head, body, tool, result, rest, answer]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages).toEqual([
      { id: "u1", role: "user", text: "最初の質問", at: Date.parse(first.timestamp) },
      {
        id: "a1",
        role: "agent",
        text: "最初の段落です。続きの段落です。",
        at: Date.parse(head.timestamp),
      },
      { id: "a5", role: "agent", text: "最後の答えです。", at: Date.parse(answer.timestamp) },
    ]);
    expect(snapshot).toMatchObject({ model: "claude-opus-5-5", effort: "low", truncated: false });
    expect(snapshot.context).toBeNull();
    expect(snapshot.compaction).toBeNull();
    expect(snapshot.usage).toBeUndefined();
  });
});

test("tool results, thinking, attachments and system entries never become rows", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "調べてください。");
    const toolOnly = assistant("a1", "u1", "msg_1", [thinking("内部の思考"), toolUse("t1")]);
    const attachment = {
      type: "attachment",
      uuid: "at1",
      parentUuid: "a1",
      timestamp: timestamp(),
      attachment: { type: "environment", content: "internal" },
    };
    const result = user("r1", "at1", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
    const synthetic = {
      type: "system",
      uuid: "s1",
      parentUuid: "r1",
      subtype: "turn_duration",
      timestamp: timestamp(),
    };
    const image = user("img1", "s1", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
    ]);
    const answer = assistant("a2", "img1", "msg_2", [text("調べました。")]);
    await writeTranscript(root, [first, toolOnly, attachment, result, synthetic, image, answer]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "調べてください。"],
      ["agent", "調べました。"],
    ]);
    // 本文を持たない assistant からもモデルと effort は採る。
    expect(snapshot).toMatchObject({ model: MODEL, effort: "xhigh" });
  });
});

test("user entries marked isMeta or isCompactSummary are not part of the conversation", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "本文です。");
    const meta = user("m1", "u1", "画面に出さない記録", { isMeta: true });
    const summary = user("c1", "m1", "以前の会話の要約", { isCompactSummary: true });
    const answer = assistant("a1", "c1", "msg_1", [text("わかりました。")]);
    await writeTranscript(root, [first, meta, summary, answer]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "本文です。",
      "わかりました。",
    ]);
  });
});

test("a compacted session keeps the conversation before the boundary and marks it", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "最初の依頼です。");
    const answer = assistant("a1", "u1", "msg_1", [text("対応します。")]);
    const cut = boundary("a1", { trigger: "auto", preTokens: 790_236 });
    const summary = user("s1", "boundary-1", SUMMARY_RAW, { isCompactSummary: true });
    await writeTranscript(root, [first, answer, cut, summary]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "最初の依頼です。",
      "対応します。",
    ]);
    expect(snapshot.compaction).toEqual({
      at: Date.parse(cut.timestamp),
      tokensBefore: 790_236,
      summary: "Summary:\n1. 最初の依頼",
      index: 2,
    });
    // 圧縮後の応答がまだ無くても、モデルと effort は最後の応答から出す。
    expect(snapshot).toMatchObject({ model: MODEL, effort: "xhigh" });
  });
});

test("the divider sits between the messages before and after compaction", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "最初の依頼です。");
    const answer = assistant("a1", "u1", "msg_1", [text("対応します。")]);
    const cut = boundary("a1");
    const summary = user("s1", "boundary-1", "これまでの要約です。", { isCompactSummary: true });
    const later = user("u2", "s1", "続きをお願いします。");
    await writeTranscript(root, [first, answer, cut, summary, later]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "最初の依頼です。",
      "対応します。",
      "続きをお願いします。",
    ]);
    expect(snapshot.compaction?.index).toBe(2);
  });
});

// 圧縮前の未解決の tool_use は、終わったターンのもの。今の待ちとして出さない。
test("an unresolved tool_use before a compaction is not a pending card", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "配色を決めてください。");
    const ask = assistant("a1", "u1", "msg_1", [
      askUse("t1", [question("好きな色は？", ["赤", "青"])]),
    ]);
    const cut = boundary("a1");
    const summary = user("s1", "boundary-1", "これまでの要約です。", { isCompactSummary: true });
    await writeTranscript(root, [first, ask, cut, summary]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.pending).toBeUndefined();
  });
});

test("the older branch is not mixed into the conversation", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "最初の依頼です。");
    const oldAnswer = assistant("a1", "u1", "msg_1", [text("古い枝の答えです。")]);
    const oldFollowUp = user("u2", "a1", "古い枝の続きです。");
    const rewind = assistant("a2", "u1", "msg_2", [text("新しい枝の答えです。")]);
    await writeTranscript(root, [first, oldAnswer, oldFollowUp, rewind]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "最初の依頼です。",
      "新しい枝の答えです。",
    ]);
  });
});

test("sub-agent entries never become rows and are not used as the leaf", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "任せます。");
    const answer = assistant("a1", "u1", "msg_1", [text("本流の答えです。")]);
    const side = assistant("s1", "a1", "msg_side", [text("サブエージェントの答えです。")], {
      isSidechain: true,
    });
    await writeTranscript(root, [first, answer, side]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "任せます。",
      "本流の答えです。",
    ]);
  });
});

test("the attached files note becomes a name-only chip without the absolute path", async () => {
  await withRoot(async (root) => {
    const note = [
      "その方針でお願いします。",
      "",
      "<attached_files>",
      "- /var/tmp/hwc/attachments/w2:p2/empty-state-reference.zip",
      "</attached_files>",
    ].join("\n");
    const first = user("u1", null, note);
    await writeTranscript(root, [first]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages).toEqual([
      {
        id: "u1",
        role: "user",
        text: "その方針でお願いします。",
        at: Date.parse(first.timestamp),
        attachments: [{ name: "empty-state-reference.zip", size: null }],
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("/var/tmp");
  });
});

test("a note that names nothing is dropped with the rest of the body kept", async () => {
  await withRoot(async (root) => {
    const unparsable = user(
      "u1",
      null,
      [
        "本文は残します。",
        "",
        "<attached_files>",
        "- /var/tmp/hwc/attachments/.env",
        "</attached_files>",
      ].join("\n"),
    );
    const unclosed = user("u2", "u1", "こちらも残します。\n\n<attached_files>\n- /var/tmp/x.zip");
    const noteOnly = user("u3", "u2", "<attached_files>\n- /var/tmp/.env\n</attached_files>");
    await writeTranscript(root, [unparsable, unclosed, noteOnly]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "本文は残します。",
      "こちらも残します。",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("/var/tmp");
    expect(JSON.stringify(snapshot)).not.toContain("<attached_files>");
  });
});

test("the pasted content wrapper Claude Code adds is not shown as body text", async () => {
  await withRoot(async (root) => {
    // 実機の Claude Code 2.1.328 と同じ形。hwc の送信は paste 経路なので、改行を含む本文は
    // `<pasted_content>` で包まれて transcript に残る。
    const wrapped = user(
      "u1",
      null,
      [
        "",
        '<pasted_content id="89c4">',
        "その 2 点でお願いします。",
        "",
        "<attached_files>",
        "- /var/tmp/hwc/attachments/w2:p2/quickstart-review.pdf",
        "</attached_files>",
        '</pasted_content id="89c4">',
        "",
      ].join("\n"),
    );
    await writeTranscript(root, [wrapped]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages).toEqual([
      {
        id: "u1",
        role: "user",
        text: "その 2 点でお願いします。",
        at: Date.parse(wrapped.timestamp),
        attachments: [{ name: "quickstart-review.pdf", size: null }],
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("pasted_content");
    expect(JSON.stringify(snapshot)).not.toContain("/var/tmp");
  });
});

test("a wrapped multi-line message keeps its lines and loses the outer blank lines", async () => {
  await withRoot(async (root) => {
    const wrapped = user(
      "u1",
      null,
      '\n\n<pasted_content id="1a2b">\n1: これで\n2: それで\n</pasted_content id="1a2b">\n',
    );
    await writeTranscript(root, [wrapped]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual(["1: これで\n2: それで"]);
  });
});

test("a wrapper without its pair stays in the body", async () => {
  await withRoot(async (root) => {
    const open = user("u1", null, '貼り付けの例です。\n\n<pasted_content id="89c4">\n本文');
    const mismatch = user(
      "u2",
      "u1",
      '<pasted_content id="89c4">\n本文\n</pasted_content id="ffff">',
    );
    await writeTranscript(root, [open, mismatch]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual([
      '貼り付けの例です。\n\n<pasted_content id="89c4">\n本文',
      '<pasted_content id="89c4">\n本文\n</pasted_content id="ffff">',
    ]);
  });
});

test("every paired wrapper in one message is unwrapped", async () => {
  await withRoot(async (root) => {
    const wrapped = user(
      "u1",
      null,
      '前置き\n\n<pasted_content id="a1">\n一つ目\n</pasted_content id="a1">\n\n<pasted_content id="b2">\n二つ目\n</pasted_content id="b2">',
    );
    await writeTranscript(root, [wrapped]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "前置き\n\n一つ目\n\n二つ目",
    ]);
  });
});

test("a failed API call becomes an error row without adopting the synthetic model", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "状態を確認してください。");
    const failure = assistant("e1", "u1", "msg_err", [text("Not logged in · Please run /login")], {
      message: {
        id: "msg_err",
        role: "assistant",
        model: "<synthetic>",
        content: [text("Not logged in · Please run /login")],
      },
      error: "authentication_failed",
      isApiErrorMessage: true,
      perTurnEffort: null,
    });
    await writeTranscript(root, [first, failure]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages).toEqual([
      { id: "u1", role: "user", text: "状態を確認してください。", at: Date.parse(first.timestamp) },
      {
        id: "e1",
        role: "error",
        text: "authentication_failed\nNot logged in · Please run /login",
        at: Date.parse(failure.timestamp),
      },
    ]);
    expect(snapshot.model).toBeNull();
    expect(snapshot.effort).toBeNull();
  });
});

test("local command echoes are not part of the conversation", async () => {
  await withRoot(async (root) => {
    const command = user(
      "c1",
      null,
      "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
    );
    const stdout = user(
      "c2",
      "c1",
      "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>",
    );
    const first = user("u1", "c2", "モデルを変えました。");
    await writeTranscript(root, [command, stdout, first]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages.map((message) => message.text)).toEqual(["モデルを変えました。"]);
  });
});

test("local command output is readable for the commands sent after a given time", async () => {
  await withRoot(async (root) => {
    const stdout = (uuid: string, parent: string | null, body: string) =>
      user(uuid, parent, `<local-command-stdout>${body}</local-command-stdout>`);
    const before = stdout("c1", null, "Set effort level to high");
    const since = BASE + clock * 1_000 + 500;
    const after = stdout("c2", "c1", "Set effort level to low (saved as your default)");
    const talk = user("u1", "c2", "本文は読まない");
    await writeTranscript(root, [before, after, talk]);

    const outputs = await createClaudeChatClient().localCommandOutputs(SESSION, since);

    expect(outputs).toEqual(["Set effort level to low (saved as your default)"]);
  });
});

test("local command output is empty when no command has run since", async () => {
  await withRoot(async (root) => {
    await writeTranscript(root, [user("u1", null, "こんにちは")]);

    expect(await createClaudeChatClient().localCommandOutputs(SESSION, 0)).toEqual([]);
  });
});

test("a session id is resolved under any project directory", async () => {
  await withRoot(async (root) => {
    // プロジェクト名は cwd のエンコードで内部形式。id だけで探せれば名前は問わない。
    const path = await writeTranscript(
      root,
      [user("u1", null, "こんにちは")],
      "-home-dev-work-acme-dashboard",
    );
    expect(path).toContain(join("projects", "-home-dev-work-acme-dashboard"));

    const snapshot = await createClaudeChatClient().snapshot(SESSION);
    expect(snapshot.messages.map((message) => message.text)).toEqual(["こんにちは"]);
  });
});

test("a missing transcript is reported so the caller falls back to the terminal", async () => {
  await withRoot(async () => {
    const client = createClaudeChatClient();
    await expect(client.snapshot(SESSION)).rejects.toBeInstanceOf(ChatUnavailableError);
    // ディレクトリを跨ぐ id はファイル名にしない。
    await expect(client.snapshot("../../etc/passwd")).rejects.toBeInstanceOf(ChatUnavailableError);
  });
});

test("an ambiguous session id is reported instead of guessing the project", async () => {
  await withRoot(async (root) => {
    await writeTranscript(root, [user("u1", null, "ひとつめ")], "one");
    await writeTranscript(root, [user("u2", null, "ふたつめ")], "two");

    await expect(createClaudeChatClient().snapshot(SESSION)).rejects.toBeInstanceOf(
      ChatUnavailableError,
    );
  });
});

test("a session id is never carried over to another CLAUDE_CONFIG_DIR", async () => {
  await withRoot(async (root) => {
    await writeTranscript(root, [user("u1", null, "こんにちは")]);
    const client = createClaudeChatClient();
    expect((await client.snapshot(SESSION)).messages).toHaveLength(1);

    process.env.CLAUDE_CONFIG_DIR = join(root, "other");
    await expect(client.snapshot(SESSION)).rejects.toBeInstanceOf(ChatUnavailableError);
  });
});

test("a missing session is remembered only for four seconds", async () => {
  await withRoot(async (root) => {
    let now = BASE;
    const client = createClaudeChatClient({ now: () => now });
    await expect(client.snapshot(SESSION)).rejects.toBeInstanceOf(ChatUnavailableError);

    await writeTranscript(root, [user("u1", null, "遅れて現れました。")]);
    // 期限は仕様値の 4 秒。実装の定数から作ると、30 秒へ戻してもこのテストが緑のままになる。
    now += 3_999;
    await expect(client.snapshot(SESSION)).rejects.toBeInstanceOf(ChatUnavailableError);

    now += 1;
    expect((await client.snapshot(SESSION)).messages.map((message) => message.text)).toEqual([
      "遅れて現れました。",
    ]);
  });
});

test("a sent message forgets the missing session before the next poll", async () => {
  await withRoot(async (root) => {
    const client = createClaudeChatClient({ now: () => BASE });
    await expect(client.snapshot(SESSION)).rejects.toBeInstanceOf(ChatUnavailableError);

    await writeTranscript(root, [user("u1", null, "送信のあとに現れました。")]);
    // 送信は時刻を進めない。TTL の内側でも、捨てた直後の取得は探し直す。
    client.forgetMissing(SESSION);

    expect((await client.snapshot(SESSION)).messages.map((message) => message.text)).toEqual([
      "送信のあとに現れました。",
    ]);
  });
});

test("an unchanged transcript keeps its etag and an appended one does not", async () => {
  await withRoot(async (root) => {
    const path = await writeTranscript(root, [user("u1", null, "最初の本文")]);
    const client = createClaudeChatClient();

    const first = await client.snapshot(SESSION);
    const again = await client.snapshot(SESSION);
    expect(again.etag).toBe(first.etag);

    const appended = assistant("a1", "u1", "msg_1", [text("追記の答え")]);
    await appendFile(path, `${JSON.stringify(appended)}\n`);
    const updated = await client.snapshot(SESSION);
    expect(updated.etag).not.toBe(first.etag);
    expect(updated.messages.map((message) => message.text)).toEqual(["最初の本文", "追記の答え"]);
  });
});

test("a transcript over the size limit is read from the tail and marked truncated", async () => {
  await withRoot(async (root) => {
    const filler = "長い本文です。".repeat(20);
    const entries = [
      user("u1", null, filler),
      user("u2", "u1", `${filler}二通目`),
      user("u3", "u2", "最後の本文"),
    ];
    await writeTranscript(root, entries);
    // 先頭の 2 行を切る大きさ。最初の完全な行を branch の起点にする。
    const client = createClaudeChatClient({
      maxBytes: Buffer.byteLength(JSON.stringify(entries[2])) + 9,
    });

    const snapshot = await client.snapshot(SESSION);

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.messages.map((message) => message.text)).toEqual(["最後の本文"]);
  });
});

test("an unreadable transcript is reported instead of an empty conversation", async () => {
  await withRoot(async (root) => {
    const directory = join(root, "projects", "demo");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${SESSION}.jsonl`), "this is not a transcript\n");

    await expect(createClaudeChatClient().snapshot(SESSION)).rejects.toBeInstanceOf(
      ChatUnavailableError,
    );
  });
});

test("an empty transcript is an empty conversation, not an error", async () => {
  await withRoot(async (root) => {
    const directory = join(root, "projects", "demo");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${SESSION}.jsonl`), "");

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.model).toBeNull();
    expect(snapshot.truncated).toBe(false);
  });
});

test("only the newest messages within the chat limit are returned", async () => {
  await withRoot(async (root) => {
    let parent: string | null = null;
    const entries = Array.from({ length: MAX_CHAT_MESSAGES + 1 }, (_, index) => {
      const entry = user(`u${index}`, parent, `本文 ${index}`);
      parent = `u${index}`;
      return entry;
    });
    await writeTranscript(root, entries);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(snapshot.messages[0]?.text).toBe("本文 1");
    expect(snapshot.messages.at(-1)?.text).toBe(`本文 ${MAX_CHAT_MESSAGES}`);
    expect(snapshot.truncated).toBe(true);
  });
});

// 区切りも、古い側を落とした分だけ前へ動く。
test("the divider follows the messages dropped by the limit", async () => {
  await withRoot(async (root) => {
    let parent: string | null = null;
    const entries = Array.from({ length: MAX_CHAT_MESSAGES + 1 }, (_, index) => {
      const entry = user(`u${index}`, parent, `本文 ${index}`);
      parent = `u${index}`;
      return entry;
    });
    const cut = boundary(parent, { preTokens: 400_000 });
    const summary = user("s1", "boundary-1", "これまでの要約です。", { isCompactSummary: true });
    const later = user("u-last", "s1", "圧縮後の発言です。");
    await writeTranscript(root, [...entries, cut, summary, later]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(snapshot.messages.at(-1)?.text).toBe("圧縮後の発言です。");
    // 502 件のうち前の 2 件を落としたので、区切りは末尾の 1 件前へ動く。
    expect(snapshot.compaction?.index).toBe(MAX_CHAT_MESSAGES - 1);
  });
});

test("an unresolved AskUserQuestion at the end of the branch becomes a question card", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "配色を決めてください。");
    const intro = assistant("a1", "u1", "msg_1", [text("確認します。")]);
    const ask = assistant("a2", "a1", "msg_1", [
      askUse("t1", [
        question("好きな色は？", ["赤", "青", "緑"], { header: "色", multiSelect: true }),
        question("次に直す場所は？", ["見出し", "本文"]),
      ]),
    ]);
    await writeTranscript(root, [first, intro, ask]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.pending).toEqual({
      kind: "question",
      toolUseId: "t1",
      tool: "AskUserQuestion",
      questions: [
        {
          question: "好きな色は？",
          header: "色",
          multiSelect: true,
          options: [
            { label: "赤", description: "赤 の説明" },
            { label: "青", description: "青 の説明" },
            { label: "緑", description: "緑 の説明" },
          ],
        },
        {
          question: "次に直す場所は？",
          header: "確認",
          multiSelect: false,
          options: [
            { label: "見出し", description: "見出し の説明" },
            { label: "本文", description: "本文 の説明" },
          ],
        },
      ],
    });
    // カードは会話の行を増やさない。
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "配色を決めてください。",
      "確認します。",
    ]);
  });
});

test("a tool_result clears the card and the conversation continues", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "好みを聞いてください。");
    const ask = assistant("a1", "u1", "msg_1", [askUse("t1", [question("好きな色は？", ["赤"])])]);
    const path = await writeTranscript(root, [first, ask]);
    const client = createClaudeChatClient();

    const waiting = await client.snapshot(SESSION);
    expect(waiting.pending).toMatchObject({ kind: "question", toolUseId: "t1" });

    const result = user("r1", "a1", [toolResult("t1")]);
    const answer = assistant("a2", "r1", "msg_2", [text("赤ですね。")]);
    await appendFile(path, `${JSON.stringify(result)}\n${JSON.stringify(answer)}\n`);

    const resolved = await client.snapshot(SESSION);

    expect(resolved.pending).toBeUndefined();
    expect(resolved.etag).not.toBe(waiting.etag);
    expect(resolved.messages.map((message) => message.text)).toEqual([
      "好みを聞いてください。",
      "赤ですね。",
    ]);
  });
});

test("parallel tool calls wait on the AskUserQuestion even when another tool comes later", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "並べて進めてください。");
    const read = assistant("a1", "u1", "msg_1", [tool("t1", "Read", { file_path: "docs/a.md" })]);
    const ask = assistant("a2", "a1", "msg_1", [
      askUse("t2", [question("このままでよいですか？", ["はい", "いいえ"])]),
    ]);
    const after = assistant("a3", "a2", "msg_1", [tool("t3", "Read", { file_path: "docs/b.md" })]);
    await writeTranscript(root, [first, read, ask, after]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.pending).toMatchObject({ kind: "question", toolUseId: "t2" });
  });
});

test("an approval wait becomes a tool card with a one-line summary", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "一回だけ確認させてください。");
    const write = assistant("a1", "u1", "msg_1", [
      tool("t1", "Write", { file_path: "docs/quickstart.md", content: "本文の全文" }),
    ]);
    await writeTranscript(root, [first, write]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.pending).toEqual({
      kind: "tool",
      toolUseId: "t1",
      tool: "Write",
      summary: "docs/quickstart.md",
    });
    // 承認待ちに input 全体を載せない（Write の content を画面と通信へ出さない）。
    expect(JSON.stringify(snapshot)).not.toContain("本文の全文");
  });
});

test("a tool without a known summary field shows only its name", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "調べてください。");
    const call = assistant("a1", "u1", "msg_1", [
      tool("t1", "mcp__demo__lookup", { query: "内部の値" }),
    ]);
    await writeTranscript(root, [first, call]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.pending).toEqual({
      kind: "tool",
      toolUseId: "t1",
      tool: "mcp__demo__lookup",
      summary: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("内部の値");
  });
});

test("the summary of a known tool is flattened to one line", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "空ファイルを作ってください。");
    const call = assistant("a1", "u1", "msg_1", [
      tool("t1", "Bash", { command: "touch /tmp/demo\n&& ls /tmp/demo" }),
    ]);
    await writeTranscript(root, [first, call]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.pending).toEqual({
      kind: "tool",
      toolUseId: "t1",
      tool: "Bash",
      summary: "touch /tmp/demo && ls /tmp/demo",
    });
  });
});

test("a malformed AskUserQuestion input does not become a card", async () => {
  await withRoot(async (root) => {
    const inputs: unknown[] = [
      { questions: "好きな色は？" },
      { questions: [] },
      { questions: [{ question: "好きな色は？", options: [] }] },
      { questions: [{ question: "", options: [{ label: "赤" }] }] },
      { questions: [{ question: "好きな色は？", options: [{ label: "" }] }] },
      null,
    ];
    for (const input of inputs) {
      const first = user("u1", null, "聞いてください。");
      const ask = assistant("a1", "u1", "msg_1", [tool("t1", "AskUserQuestion", input)]);
      await writeTranscript(root, [first, ask]);
      // 使い回しの射影に当たらないよう、毎回作り直して読む。
      const snapshot = await createClaudeChatClient().snapshot(SESSION);
      expect(snapshot.pending).toBeUndefined();
    }
  });
});

test("a pending tool is not shown when the branch ends with a user message", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "これで進めてください。");
    const call = assistant("a1", "u1", "msg_1", [
      tool("t1", "Bash", { command: "touch /tmp/demo" }),
    ]);
    const note = user("u2", "a1", "承認します。");
    await writeTranscript(root, [first, call, note]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.pending).toBeUndefined();
  });
});

test("question text is flattened, stripped and cut to the limits", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "選択肢をください。");
    const ask = assistant("a1", "u1", "msg_1", [
      askUse("t1", [
        {
          question: `色\r\nは\u0000何\tですか ${"長".repeat(2_100)}`,
          header: "見".repeat(150),
          multiSelect: true,
          options: Array.from({ length: 12 }, (_, index) => ({
            label: `選択肢${index}`,
            description: "説".repeat(1_100),
          })),
        },
        ...Array.from({ length: 5 }, () => question("余分な質問", ["はい"])),
      ]),
    ]);
    await writeTranscript(root, [first, ask]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);
    const pending = snapshot.pending;

    expect(pending?.kind).toBe("question");
    if (pending?.kind !== "question") return;
    // 質問は 4 件、選択肢は 10 件まで。
    expect(pending.questions).toHaveLength(4);
    const [head] = pending.questions;
    expect(head?.question.startsWith("色 は何 ですか ")).toBe(true);
    expect(head?.question).toHaveLength(2_000);
    expect(head?.question).not.toMatch(/\p{Cc}/u);
    expect(head?.header).toHaveLength(100);
    expect(head?.multiSelect).toBe(true);
    expect(head?.options).toHaveLength(10);
    expect(head?.options[0]?.description).toHaveLength(1_000);
  });
});

// 実機（Claude Code 2.1.328）は、質問と承認の待ちの間は assistant の tool_use を transcript に
// 書かず、ダイアログを閉じたときに tool_result と一緒に書く。待ちは hook の sidecar が教える。
async function withSidecar(
  run: (dirs: { root: string; pendingRoot: string }) => Promise<void>,
): Promise<void> {
  await withRoot(async (root) => {
    const pendingRoot = join(root, "pending");
    await mkdir(pendingRoot, { recursive: true });
    await run({ root, pendingRoot });
  });
}

const sidecarQuestion: ChatPending = {
  kind: "question",
  toolUseId: "t1",
  tool: "AskUserQuestion",
  questions: [question("好きな色は？", ["赤", "青"])],
};

async function writeSidecar(
  pendingRoot: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(pendingRoot, `${SESSION}.json`),
    JSON.stringify({
      v: 1,
      sessionId: SESSION,
      at: BASE,
      toolUseId: "t1",
      tool: "AskUserQuestion",
      pending: sidecarQuestion,
      ...fields,
    }),
  );
}

test("the context the mod recorded is shown and is part of the etag", async () => {
  await withRoot(async (root) => {
    await writeTranscript(root, [user("u1", null, "本文です。")]);
    const liveRoot = join(root, "live");
    await mkdir(liveRoot, { recursive: true });
    await writeFile(
      join(liveRoot, `${SESSION}.json`),
      JSON.stringify({
        v: 1,
        sessionId: SESSION,
        at: BASE,
        tokPerSecond: null,
        context: { tokens: 122_600, window: 1_000_000 },
        contextAt: BASE,
      }),
    );

    const snapshot = await createClaudeChatClient({ liveRoot, now: () => BASE }).snapshot(SESSION);
    const without = await createClaudeChatClient({ now: () => BASE }).snapshot(SESSION);

    expect(snapshot.context).toEqual({ tokens: 122_600, window: 1_000_000 });
    expect(without.context).toBeNull();
    expect(snapshot.etag).not.toBe(without.etag);
  });
});

// 使用量はターンの終わりにしか変わらない。速度の鮮度が切れても、次のターンまで表示を保つ。
test("an old live file still supplies the context", async () => {
  await withRoot(async (root) => {
    await writeTranscript(root, [user("u1", null, "本文です。")]);
    const liveRoot = join(root, "live");
    await mkdir(liveRoot, { recursive: true });
    await writeFile(
      join(liveRoot, `${SESSION}.json`),
      JSON.stringify({
        v: 1,
        sessionId: SESSION,
        at: BASE,
        tokPerSecond: 68.4,
        context: { tokens: 40_000, window: 200_000 },
        contextAt: BASE,
      }),
    );

    const snapshot = await createClaudeChatClient({
      liveRoot,
      now: () => BASE + LIVE_TTL_MS + 1,
    }).snapshot(SESSION);

    expect(snapshot.context).toEqual({ tokens: 40_000, window: 200_000 });
  });
});

// 圧縮は文脈を切り詰める。圧縮より前に読んだ使用量は、圧縮前の量。
test("a context read before a compaction is not shown", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "本文です。");
    const answer = assistant("a1", "u1", "msg_1", [text("返事です。")]);
    const cut = boundary("a1");
    const summary = user("s1", "boundary-1", "これまでの要約です。", { isCompactSummary: true });
    await writeTranscript(root, [first, answer, cut, summary]);
    const liveRoot = join(root, "live");
    await mkdir(liveRoot, { recursive: true });
    await writeFile(
      join(liveRoot, `${SESSION}.json`),
      JSON.stringify({
        v: 1,
        sessionId: SESSION,
        // ターン中の publish は、圧縮前の context に新しい at を付けて書く。
        at: Date.parse(cut.timestamp) + 60_000,
        tokPerSecond: 68.4,
        context: { tokens: 790_032, window: 1_000_000 },
        contextAt: Date.parse(cut.timestamp) - 60_000,
      }),
    );

    const snapshot = await createClaudeChatClient({ liveRoot, now: () => BASE }).snapshot(SESSION);

    expect(snapshot.context).toBeNull();
  });
});

test("a context read after the compaction is shown", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "本文です。");
    const answer = assistant("a1", "u1", "msg_1", [text("返事です。")]);
    const cut = boundary("a1");
    const summary = user("s1", "boundary-1", "これまでの要約です。", { isCompactSummary: true });
    await writeTranscript(root, [first, answer, cut, summary]);
    const liveRoot = join(root, "live");
    await mkdir(liveRoot, { recursive: true });
    await writeFile(
      join(liveRoot, `${SESSION}.json`),
      JSON.stringify({
        v: 1,
        sessionId: SESSION,
        at: Date.parse(cut.timestamp) + 1,
        tokPerSecond: null,
        context: { tokens: 13_804, window: 1_000_000 },
        contextAt: Date.parse(cut.timestamp) + 1,
      }),
    );

    const snapshot = await createClaudeChatClient({ liveRoot, now: () => BASE }).snapshot(SESSION);

    expect(snapshot.context).toEqual({ tokens: 13_804, window: 1_000_000 });
  });
});

test("another session's live file adds no context", async () => {
  await withRoot(async (root) => {
    await writeTranscript(root, [user("u1", null, "本文です。")]);
    const liveRoot = join(root, "live");
    await mkdir(liveRoot, { recursive: true });
    await writeFile(
      join(liveRoot, "another-session.json"),
      JSON.stringify({
        v: 1,
        sessionId: "another-session",
        at: BASE,
        tokPerSecond: null,
        context: { tokens: 122_600, window: 1_000_000 },
        contextAt: BASE,
      }),
    );

    const snapshot = await createClaudeChatClient({ liveRoot, now: () => BASE }).snapshot(SESSION);

    expect(snapshot.context).toBeNull();
  });
});

test("a question the hook recorded is shown even though the transcript has no tool_use yet", async () => {
  await withSidecar(async ({ root, pendingRoot }) => {
    await writeTranscript(root, [user("u1", null, "色を聞いてください。")]);
    await writeSidecar(pendingRoot);

    const snapshot = await createClaudeChatClient({ pendingRoot, now: () => BASE }).snapshot(
      SESSION,
    );

    expect(snapshot.pending).toEqual(sidecarQuestion);
    expect(snapshot.messages.map((message) => message.text)).toEqual(["色を聞いてください。"]);
  });
});

test("the wait is part of the etag so the card is not hidden by a 304", async () => {
  await withSidecar(async ({ root, pendingRoot }) => {
    await writeTranscript(root, [user("u1", null, "色を聞いてください。")]);
    const client = createClaudeChatClient({ pendingRoot, now: () => BASE });
    const without = await client.snapshot(SESSION);

    await writeSidecar(pendingRoot);
    const withCard = await client.snapshot(SESSION);

    expect(without.pending).toBeUndefined();
    expect(withCard.etag).not.toBe(without.etag);
  });
});

test("Esc leaves the file behind, but the tool_result the CLI writes resolves the question", async () => {
  await withSidecar(async ({ root, pendingRoot }) => {
    const first = user("u1", null, "色を聞いてください。");
    const ask = assistant("a1", "u1", "msg_1", [askUse("t1", [question("好きな色は？", ["赤"])])]);
    const rejected = user("u2", "a1", [{ ...toolResult("t1"), is_error: true }]);
    const interrupted = user("u3", "u2", [text("[Request interrupted by user for tool use]")]);
    await writeTranscript(root, [first, ask, rejected, interrupted]);
    await writeSidecar(pendingRoot);

    const snapshot = await createClaudeChatClient({ pendingRoot, now: () => BASE }).snapshot(
      SESSION,
    );

    expect(snapshot.pending).toBeUndefined();
  });
});

test("a tool approval the hook recorded is shown with its summary", async () => {
  await withSidecar(async ({ root, pendingRoot }) => {
    await writeTranscript(root, [user("u1", null, "ファイルを作ってください。")]);
    await writeSidecar(pendingRoot, {
      toolUseId: "t2",
      tool: "Bash",
      pending: { kind: "tool", toolUseId: "t2", tool: "Bash", summary: "touch ./probe" },
    });

    const snapshot = await createClaudeChatClient({ pendingRoot, now: () => BASE }).snapshot(
      SESSION,
    );

    expect(snapshot.pending).toEqual({
      kind: "tool",
      toolUseId: "t2",
      tool: "Bash",
      summary: "touch ./probe",
    });
  });
});

test("a record older than its lifetime, a started tool and another session's file show no card", async () => {
  await withSidecar(async ({ root, pendingRoot }) => {
    await writeTranscript(root, [user("u1", null, "色を聞いてください。")]);
    const client = createClaudeChatClient({ pendingRoot, now: () => BASE + SIDECAR_TTL_MS + 1 });

    await writeSidecar(pendingRoot);
    expect((await client.snapshot(SESSION)).pending).toBeUndefined();

    await writeSidecar(pendingRoot, { pending: null });
    expect(
      (await createClaudeChatClient({ pendingRoot, now: () => BASE }).snapshot(SESSION)).pending,
    ).toBeUndefined();

    await writeSidecar(pendingRoot, { sessionId: "another-session" });
    expect(
      (await createClaudeChatClient({ pendingRoot, now: () => BASE }).snapshot(SESSION)).pending,
    ).toBeUndefined();
  });
});

test("without a pending root only the transcript decides", async () => {
  await withSidecar(async ({ root, pendingRoot }) => {
    await writeTranscript(root, [user("u1", null, "色を聞いてください。")]);
    await writeSidecar(pendingRoot);

    const snapshot = await createClaudeChatClient({ now: () => BASE }).snapshot(SESSION);

    expect(snapshot.pending).toBeUndefined();
  });
});

test("the hook's record wins over an unresolved tool_use at the end of the transcript", async () => {
  await withSidecar(async ({ root, pendingRoot }) => {
    const first = user("u1", null, "続けてください。");
    const ask = assistant("a1", "u1", "msg_1", [tool("t9", "Bash", { command: "ls" })]);
    await writeTranscript(root, [first, ask]);
    await writeSidecar(pendingRoot);

    const snapshot = await createClaudeChatClient({ pendingRoot, now: () => BASE }).snapshot(
      SESSION,
    );

    expect(snapshot.pending).toEqual(sidecarQuestion);
  });
});

test("the marker the CLI writes when Esc interrupts a turn is not a user message", async () => {
  await withRoot(async (root) => {
    const first = user("u1", null, "続けてください。");
    const ask = assistant("a1", "u1", "msg_1", [askUse("t1", [question("好きな色は？", ["赤"])])]);
    const rejected = user("u2", "a1", [{ ...toolResult("t1"), is_error: true }]);
    const interrupted = user("u3", "u2", [text("[Request interrupted by user for tool use]")]);
    const interruptedTurn = user("u4", "u3", "[Request interrupted by user]");
    const answer = user("u5", "u4", "好きな色は？: 青");
    await writeTranscript(root, [first, ask, rejected, interrupted, interruptedTurn, answer]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    // 質問への回答として送った本文だけが、ユーザーの発言として残る。
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "続けてください。",
      "好きな色は？: 青",
    ]);
  });
});

// 質問の tool_use と、それに続く記録。Web から答えると tool_result は却下され、Esc の記録の後に
// `質問への回答:` で始まる発話が残る。TUI で答えると tool_result が答えを持つ。
const rejected = (id: string) => ({ ...toolResult(id), is_error: true });

async function askConversation(
  entries: (parent: string) => unknown[],
  questions: unknown,
): Promise<Awaited<ReturnType<ReturnType<typeof createClaudeChatClient>["snapshot"]>>> {
  let result:
    | Awaited<ReturnType<ReturnType<typeof createClaudeChatClient>["snapshot"]>>
    | undefined;
  await withRoot(async (root) => {
    const first = user("u1", null, "確認してください。");
    const lead = assistant("a0", "u1", "msg_0", [text("質問します。")]);
    const ask = assistant("a1", "a0", "msg_0", [askUse("t1", questions)]);
    await writeTranscript(root, [first, lead, ask, ...entries("a1")]);
    result = await createClaudeChatClient().snapshot(SESSION);
  });
  if (result === undefined) throw new Error("snapshot was not taken");
  return result;
}

const interrupt = (uuid: string, parent: string) =>
  user(uuid, parent, [text("[Request interrupted by user for tool use]")]);

test("a question answered from the web becomes the question with its options and the answer", async () => {
  const snapshot = await askConversation(
    (parent) => [
      user("u2", parent, [rejected("t1")]),
      interrupt("u3", "u2"),
      user("u4", "u3", "質問への回答:\n好きな色は？: 青\nどれを使いますか？: りんご, もも"),
    ],
    [
      question("好きな色は？", ["赤", "青"]),
      question("どれを使いますか？", ["りんご", "なし", "もも"], { multiSelect: true }),
    ],
  );

  // 質問文は text と同じ assistant の応答の後ろ、回答は質問の直後。素の回答本文は残さない。
  expect(snapshot.messages.map((message) => [message.role, message.text])).toEqual([
    ["user", "確認してください。"],
    ["agent", "質問します。"],
    ["agent", "好きな色は？"],
    ["user", "青"],
    ["agent", "どれを使いますか？"],
    ["user", "りんご, もも"],
  ]);
  const [, , colorQuestion, colorAnswer, fruitQuestion, fruitAnswer] = snapshot.messages;
  expect(colorQuestion?.askOptions).toEqual([
    { label: "赤", recommended: false, selected: false },
    { label: "青", recommended: false, selected: true },
  ]);
  expect(fruitQuestion?.askOptions?.map((option) => option.selected)).toEqual([true, false, true]);
  expect([colorQuestion, colorAnswer, fruitQuestion, fruitAnswer].map((m) => m?.synthetic)).toEqual(
    [true, true, true, true],
  );
  expect([colorAnswer?.answerKind, fruitAnswer?.answerKind]).toEqual(["option", "option"]);
  expect(snapshot.pending).toBeUndefined();
});

test("a free text answer from the web selects no option", async () => {
  const snapshot = await askConversation(
    (parent) => [
      user("u2", parent, [rejected("t1")]),
      interrupt("u3", "u2"),
      user("u4", "u3", "質問への回答:\n好きな色は？: 緑に近い 青です"),
    ],
    [question("好きな色は？", ["赤", "青"])],
  );

  const [, , asked, answered] = snapshot.messages;
  expect(asked?.askOptions?.map((option) => option.selected)).toEqual([false, false]);
  expect(answered).toMatchObject({ role: "user", text: "緑に近い 青です", answerKind: "text" });
});

test("the answer Claude Code wraps as a paste is still read as the answer", async () => {
  const snapshot = await askConversation(
    (parent) => [
      user("u2", parent, [rejected("t1")]),
      interrupt("u3", "u2"),
      user(
        "u4",
        "u3",
        '<pasted_content id="p1">\n質問への回答:\n好きな色は？: 赤\n</pasted_content id="p1">',
      ),
    ],
    [question("好きな色は？", ["赤", "青"])],
  );

  expect(snapshot.messages.map((message) => message.text)).toEqual([
    "確認してください。",
    "質問します。",
    "好きな色は？",
    "赤",
  ]);
});

test("a question answered in the terminal dialog becomes the question and the answer", async () => {
  const snapshot = await askConversation(
    (parent) => [
      user("u2", parent, [toolResult("t1")], {
        toolUseResult: {
          questions: [],
          answers: { "好きな色は？": "青", "どれを使いますか？": "りんご, もも" },
          annotations: {},
        },
      }),
    ],
    [
      question("好きな色は？", ["赤", "青"]),
      question("どれを使いますか？", ["りんご", "なし", "もも"], { multiSelect: true }),
    ],
  );

  expect(snapshot.messages.map((message) => [message.role, message.text])).toEqual([
    ["user", "確認してください。"],
    ["agent", "質問します。"],
    ["agent", "好きな色は？"],
    ["user", "青"],
    ["agent", "どれを使いますか？"],
    ["user", "りんご, もも"],
  ]);
  expect(snapshot.messages[2]?.askOptions?.map((option) => option.selected)).toEqual([false, true]);
  expect(snapshot.messages[4]?.askOptions?.map((option) => option.selected)).toEqual([
    true,
    false,
    true,
  ]);
});

test("an answer typed as Other in the terminal dialog is free text", async () => {
  const snapshot = await askConversation(
    (parent) => [
      user("u2", parent, [toolResult("t1")], {
        toolUseResult: { questions: [], answers: { "好きな色は？": "緑に近い青" } },
      }),
    ],
    [question("好きな色は？", ["赤", "青"])],
  );

  const [, , asked, answered] = snapshot.messages;
  expect(asked?.askOptions?.map((option) => option.selected)).toEqual([false, false]);
  expect(answered).toMatchObject({ text: "緑に近い青", answerKind: "text" });
});

test("a question that was rejected and not answered by the heading is not synthesized", async () => {
  const snapshot = await askConversation(
    (parent) => [
      user("u2", parent, [rejected("t1")]),
      interrupt("u3", "u2"),
      user("u4", "u3", "やっぱり別の方法にしましょう。"),
    ],
    [question("好きな色は？", ["赤", "青"])],
  );

  // 質問も回答も会話の実体ではない。普通の発話はそのまま残る。
  expect(snapshot.messages.map((message) => message.text)).toEqual([
    "確認してください。",
    "質問します。",
    "やっぱり別の方法にしましょう。",
  ]);
  expect(snapshot.messages.some((message) => message.synthetic === true)).toBe(false);
});

test("an answer that does not match the questions stays as the user's message", async () => {
  const snapshot = await askConversation(
    (parent) => [
      user("u2", parent, [rejected("t1")]),
      interrupt("u3", "u2"),
      user("u4", "u3", "質問への回答:\n別の質問: 青"),
    ],
    [question("好きな色は？", ["赤", "青"])],
  );

  expect(snapshot.messages.at(-1)).toMatchObject({
    role: "user",
    text: "質問への回答:\n別の質問: 青",
  });
  expect(snapshot.messages.some((message) => message.synthetic === true)).toBe(false);
});

test("a question still waiting for an answer is left to the pending card", async () => {
  const snapshot = await askConversation(() => [], [question("好きな色は？", ["赤", "青"])]);

  expect(snapshot.messages.map((message) => message.text)).toEqual([
    "確認してください。",
    "質問します。",
  ]);
});

test("when the cut falls between a question and its answer, the answer is not left alone", async () => {
  await withRoot(async (root) => {
    const first = user("u0", null, "確認してください。");
    const ask = assistant("a1", "u0", "msg_a", [
      askUse("t1", [question("好きな色は？", ["赤", "青"])]),
    ]);
    const answered = user("u2", "a1", [toolResult("t1")], {
      toolUseResult: { answers: { "好きな色は？": "青" } },
    });
    // 後ろに上限より 1 件少ない発話が続くと、古い側の切り捨ては質問だけを落とし、回答は
    // 上限の先頭に残る。
    const later: unknown[] = [];
    let parent = "u2";
    for (let index = 0; index < MAX_CHAT_MESSAGES - 1; index += 1) {
      const uuid = `p${index}`;
      later.push(user(uuid, parent, `発話 ${index}`));
      parent = uuid;
    }
    await writeTranscript(root, [first, ask, answered, ...later]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.messages.map((message) => message.id)).not.toContain("ask:t1:0:answer");
    expect(snapshot.messages.some((message) => message.synthetic === true)).toBe(false);
    expect(snapshot.messages).toHaveLength(MAX_CHAT_MESSAGES - 1);
  });
});

test("a question and its answer both within the limit are kept together", async () => {
  const snapshot = await askConversation(
    () => [
      user("u2", "a1", [toolResult("t1")], {
        toolUseResult: { answers: { "好きな色は？": "青" } },
      }),
    ],
    [question("好きな色は？", ["赤", "青"])],
  );

  expect(snapshot.messages.map((message) => message.id).slice(-2)).toEqual([
    "ask:t1:0:question",
    "ask:t1:0:answer",
  ]);
});

test("a completed main-thread reply that wrote the whole prompt cache for 1h sets the expiry", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    await writeTranscript(root, [prompt, req, answer]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    // 起点は応答の時刻ではなく、要求の送信時刻。
    expect(snapshot.cacheExpiresAt).toBe(Date.parse(req.timestamp) + HOUR_MS);
  });
});

test("a read-only reply extends the expiry only while the same model and effort are still warm", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const first = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    const second = request("api-2");
    const read = reply("a2", "a1", "msg-2", "api-2", cacheUsage(0, 0, 12_000));
    await writeTranscript(root, [prompt, first, answer, second, read]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.cacheExpiresAt).toBe(Date.parse(second.timestamp) + HOUR_MS);
  });
});

test("a read-only reply without a warm 1h cache does not start the expiry", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const read = reply("a1", "u1", "msg-1", "api-1", cacheUsage(0, 0, 12_000));
    await writeTranscript(root, [prompt, req, read]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.cacheExpiresAt).toBeUndefined();
  });
});

test("a read-only reply sent after the expiry withdraws the old expiry", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const first = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    // 期限を過ぎた時刻に送った要求。実時間は待たずに、記録の時刻だけで確かめる。
    const late = request("api-2", {
      timestamp: new Date(Date.parse(first.timestamp) + 2 * HOUR_MS).toISOString(),
    });
    const read = reply("a2", "a1", "msg-2", "api-2", cacheUsage(0, 0, 12_000));
    await writeTranscript(root, [prompt, first, answer, late, read]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.cacheExpiresAt).toBeUndefined();
  });
});

test("a write that is not all 1h, no cache or an unreadable usage withdraws the old expiry", async () => {
  const cases: [string, unknown][] = [
    ["a 5m write", cacheUsage(0, 12_000)],
    ["a mixed 1h and 5m write", cacheUsage(6_000, 6_000)],
    ["no cache at all", cacheUsage(0, 0, 0)],
    ["a missing breakdown", { cache_creation_input_tokens: 12_000, cache_read_input_tokens: 0 }],
    [
      "a negative count",
      {
        cache_creation_input_tokens: -1,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: -1, ephemeral_5m_input_tokens: 0 },
      },
    ],
  ];

  for (const [name, usage] of cases) {
    await withRoot(async (root) => {
      const prompt = user("u1", null, "続けてください。");
      const first = request("api-1");
      const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
      const second = request("api-2");
      const next = reply("a2", "a1", "msg-2", "api-2", usage);
      await writeTranscript(root, [prompt, first, answer, second, next]);

      const snapshot = await createClaudeChatClient().snapshot(SESSION);

      expect(`${name}: ${String(snapshot.cacheExpiresAt)}`).toBe(`${name}: undefined`);
    });
  }
});

test("blocks split from one completed request are counted once", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const first = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000), {
      blocks: [text("前半です。")],
    });
    // 同じ要求の後半の block。先に 1h と確かめたので、後半の 5m で取り下げない。
    const second = reply("a2", "a1", "msg-1", "api-1", cacheUsage(0, 12_000), {
      blocks: [text("後半です。")],
    });
    await writeTranscript(root, [prompt, req, first, second]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.cacheExpiresAt).toBe(Date.parse(req.timestamp) + HOUR_MS);
  });
});

test("failed, interrupted, sub-agent and other-branch replies leave the expiry alone", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const first = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));

    const syntheticReq = request("api-2");
    const synthetic = reply("a2", "a1", "msg-2", "api-2", cacheUsage(0, 12_000), {
      model: SYNTHETIC,
      entry: { isApiErrorMessage: true, error: "API failed" },
    });
    const failedReq = request("api-3");
    const failed = reply("a3", "a2", "msg-3", "api-3", cacheUsage(0, 12_000), {
      entry: { isApiErrorMessage: true, error: "API failed" },
    });
    const sideReq = request("api-4");
    const side = reply("a4", "a3", "msg-4", "api-4", cacheUsage(0, 12_000), {
      entry: { isSidechain: true },
    });
    const noRef = reply("a5", "a4", "msg-5", null, cacheUsage(0, 12_000));

    const interrupted = user("u2", "a5", "止めた要求です。");
    const interruptedReq = request("api-5");

    // 別の枝。active branch の葉は最後の user で終わるので、この応答は混ざらない。
    const oldPrompt = user("u3", "a5", "古い枝です。");
    const oldReq = request("api-6");
    const oldAnswer = reply("a6", "u3", "msg-6", "api-6", cacheUsage(0, 12_000));
    const leaf = user("u4", "a5", "いまの枝です。");

    await writeTranscript(root, [
      prompt,
      first,
      answer,
      syntheticReq,
      synthetic,
      failedReq,
      failed,
      sideReq,
      side,
      noRef,
      interrupted,
      interruptedReq,
      oldPrompt,
      oldReq,
      oldAnswer,
      leaf,
    ]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.cacheExpiresAt).toBe(Date.parse(first.timestamp) + HOUR_MS);
  });
});

test("a compaction boundary or summary drops the expiry before it", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    await writeTranscript(root, [prompt, req, answer, boundary("a1")]);

    expect((await createClaudeChatClient().snapshot(SESSION)).cacheExpiresAt).toBeUndefined();
  });

  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    const summary = user("s1", "a1", "これまでの要約です。", { isCompactSummary: true });
    await writeTranscript(root, [prompt, req, answer, summary]);

    expect((await createClaudeChatClient().snapshot(SESSION)).cacheExpiresAt).toBeUndefined();
  });
});

test("a 1h write after compaction starts a new expiry", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const first = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    const cut = boundary("a1");
    const summary = user("s1", "boundary-1", "これまでの要約です。", { isCompactSummary: true });
    const next = request("api-2");
    const renewed = reply("a2", "s1", "msg-2", "api-2", cacheUsage(12_000));
    await writeTranscript(root, [prompt, first, answer, cut, summary, next, renewed]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.cacheExpiresAt).toBe(Date.parse(next.timestamp) + HOUR_MS);
  });
});

test("a requested model or effort change drops the expiry, but a cancelled change keeps it", async () => {
  const commands = [
    "Set model to `opus` and saved as your default for new sessions",
    "Set effort level to high (saved as your default for new sessions)",
  ];
  for (const command of commands) {
    await withRoot(async (root) => {
      const prompt = user("u1", null, "続けてください。");
      const req = request("api-1");
      const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
      const changed = user("c1", "a1", `<local-command-stdout>${command}</local-command-stdout>`);
      await writeTranscript(root, [prompt, req, answer, changed]);

      expect((await createClaudeChatClient().snapshot(SESSION)).cacheExpiresAt).toBeUndefined();
    });
  }

  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    const kept = user(
      "c1",
      "a1",
      "<local-command-stdout>Kept model as `opus`</local-command-stdout>",
    );
    await writeTranscript(root, [prompt, req, answer, kept]);

    expect((await createClaudeChatClient().snapshot(SESSION)).cacheExpiresAt).toBe(
      Date.parse(req.timestamp) + HOUR_MS,
    );
  });
});

test("a model or effort discovered only in a reply is not extended from the old one", async () => {
  const changedCases = [
    { model: "claude-opus-5-5", effort: undefined },
    { model: MODEL, effort: "low" },
  ];
  for (const change of changedCases) {
    await withRoot(async (root) => {
      const prompt = user("u1", null, "続けてください。");
      const first = request("api-1");
      const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
      const second = request("api-2");
      const read = reply("a2", "a1", "msg-2", "api-2", cacheUsage(0, 0, 12_000), change);
      await writeTranscript(root, [prompt, first, answer, second, read]);

      expect((await createClaudeChatClient().snapshot(SESSION)).cacheExpiresAt).toBeUndefined();
    });
  }
});

test("a reply to a request sent before the boundary does not bring the expiry back", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    const cut = boundary("a1");
    const summary = user("s1", "boundary-1", "これまでの要約です。", { isCompactSummary: true });
    // 境界の後に応答だけが載った形。要求は境界より前なので、新しい期限にしない。
    const late = reply("a2", "s1", "msg-2", "api-1", cacheUsage(12_000));
    await writeTranscript(root, [prompt, req, answer, cut, summary, late]);

    expect((await createClaudeChatClient().snapshot(SESSION)).cacheExpiresAt).toBeUndefined();
  });
});

test("a completed reply whose request line is missing withdraws the last expiry", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    // 要求の行が無い応答は、送信時刻を確かめられない。前の期限を根拠なく残さず取り下げる。
    const unpaired = reply("a2", "a1", "msg-2", "api-missing", cacheUsage(0, 12_000));
    await writeTranscript(root, [prompt, req, answer, unpaired]);

    expect((await createClaudeChatClient().snapshot(SESSION)).cacheExpiresAt).toBeUndefined();
  });
});

test("a read-only reply whose effort cannot be compared does not extend the expiry", async () => {
  const efforts: [string | null, string][] = [
    [null, "high"],
    ["xhigh", "high"],
  ];
  for (const [firstEffort, secondEffort] of efforts) {
    await withRoot(async (root) => {
      const prompt = user("u1", null, "続けてください。");
      const first = request("api-1");
      const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000), {
        effort: firstEffort,
      });
      const second = request("api-2");
      const read = reply("a2", "a1", "msg-2", "api-2", cacheUsage(0, 0, 12_000), {
        effort: secondEffort,
      });
      await writeTranscript(root, [prompt, first, answer, second, read]);

      expect((await createClaudeChatClient().snapshot(SESSION)).cacheExpiresAt).toBeUndefined();
    });
  }
});

test("an unreadable usage hides only the cache and keeps the conversation", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const req = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", "not an object");
    await writeTranscript(root, [prompt, req, answer]);

    const snapshot = await createClaudeChatClient().snapshot(SESSION);

    expect(snapshot.cacheExpiresAt).toBeUndefined();
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "続けてください。",
      "返事です。",
    ]);
    expect(snapshot.model).toBe(MODEL);
  });
});

test("the expiry stays out of the passage of time but its change moves the etag", async () => {
  await withRoot(async (root) => {
    const prompt = user("u1", null, "続けてください。");
    const first = request("api-1");
    const answer = reply("a1", "u1", "msg-1", "api-1", cacheUsage(12_000));
    const path = await writeTranscript(root, [prompt, first, answer]);
    const expiresAt = Date.parse(first.timestamp) + HOUR_MS;

    const startedAt = BASE;
    const before = await createClaudeChatClient({ now: () => startedAt }).snapshot(SESSION);
    const later = await createClaudeChatClient({ now: () => startedAt + 30 * 60_000 }).snapshot(
      SESSION,
    );
    expect(later.etag).toBe(before.etag);
    expect(later.cacheExpiresAt).toBe(expiresAt);

    const second = request("api-2");
    const renewed = reply("a2", "a1", "msg-2", "api-2", cacheUsage(12_000));
    await appendFile(path, [second, renewed].map((entry) => `${JSON.stringify(entry)}\n`).join(""));

    const after = await createClaudeChatClient({ now: () => startedAt }).snapshot(SESSION);
    expect(after.etag).not.toBe(before.etag);
    expect(after.cacheExpiresAt).toBe(Date.parse(second.timestamp) + HOUR_MS);
  });
});
