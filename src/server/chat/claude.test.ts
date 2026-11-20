import { beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeChatClient, MISSING_TTL_MS } from "./claude";
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
    // 覚えている間は探し直さない。2 秒ごとの poll でも 2 回目には期限が切れる。
    now += MISSING_TTL_MS - 1;
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
