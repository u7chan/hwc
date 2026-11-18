import { beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeChatClient } from "./claude";
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

test("a missing session is remembered only for a short while", async () => {
  await withRoot(async (root) => {
    let now = BASE;
    const client = createClaudeChatClient({ now: () => now });
    await expect(client.snapshot(SESSION)).rejects.toBeInstanceOf(ChatUnavailableError);

    await writeTranscript(root, [user("u1", null, "遅れて現れました。")]);
    await expect(client.snapshot(SESSION)).rejects.toBeInstanceOf(ChatUnavailableError);

    now += 30_000;
    expect((await client.snapshot(SESSION)).messages.map((message) => message.text)).toEqual([
      "遅れて現れました。",
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
