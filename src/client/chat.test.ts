import { expect, test } from "bun:test";
import type { ChatContext, ChatFile, ChatMessage, ChatSnapshot } from "../server/chat/contract";
import type { PendingMessage } from "./chat";
import { CHAT_POLL_ACTIVE_MS, CHAT_POLL_IDLE_MS } from "./api";
import { MARKDOWN_MAX_LENGTH } from "./markdown/parse";
import {
  agentInfo,
  ANSWER_ECHO_GRACE_MS,
  answerEchoReleaseAt,
  answerEchoReleased,
  cacheView,
  chatPollDelay,
  compactionLabel,
  contextDetails,
  contextFill,
  contextMeter,
  contextPercent,
  contextText,
  contextTone,
  chatRows,
  compactionInsertIndex,
  echoInsertIndex,
  formatTokens,
  idleEchoExpired,
  isPendingConfirmed,
  latestUserAt,
  messageFileDisplayName,
  messageLinks,
  messageFileKindLabel,
  newSessionPending,
  newSessionReset,
  newSessionSnapshot,
  paneBody,
  pendingCard,
  PENDING_TURN_GRACE_MS,
  pollOnStatusChange,
  splitInlineImages,
} from "./chat";

const snapshot: ChatSnapshot = {
  etag: "abc",
  messages: [{ id: "m1", role: "user", text: "hello", at: 1_000 }],
  model: "pi-large",
  effort: "high",
  truncated: false,
  context: null,
  compaction: null,
};

const empty: ChatSnapshot = { ...snapshot, messages: [] };

test("a working pane is read more often than an idle one", () => {
  expect(chatPollDelay("working", "visible")).toBe(CHAT_POLL_ACTIVE_MS);
  expect(chatPollDelay("idle", "visible")).toBe(CHAT_POLL_IDLE_MS);
  // 要対応でも読む頻度は待機と同じ。返答は止まっている。
  expect(chatPollDelay("blocked", "visible")).toBe(CHAT_POLL_IDLE_MS);
});

test("a hidden page stops reading the conversation", () => {
  expect(chatPollDelay("working", "hidden")).toBeNull();
  expect(chatPollDelay("idle", "hidden")).toBeNull();
});

test("a turn that starts while the pane waits is read without waiting", () => {
  // idle の 5 秒待機中に working へ変わる。予約を待たずに読む。
  expect(pollOnStatusChange({ last: "idle", next: "working", visible: true })).toBe("load");
  expect(pollOnStatusChange({ last: "blocked", next: "working", visible: true })).toBe("load");
});

test("the end of a turn is read without waiting", () => {
  expect(pollOnStatusChange({ last: "working", next: "done", visible: true })).toBe("load");
  expect(pollOnStatusChange({ last: "working", next: "idle", visible: true })).toBe("load");
});

test("the first load is not asked for twice", () => {
  // マウント直後とペイン切替直後は、最初の取得と同じ状態でここへ来る。
  expect(pollOnStatusChange({ last: "working", next: "working", visible: true })).toBe("ignore");
  expect(pollOnStatusChange({ last: "idle", next: "idle", visible: true })).toBe("ignore");
});

test("a status change does not read while the page is hidden", () => {
  expect(pollOnStatusChange({ last: "idle", next: "working", visible: false })).toBe("ignore");
});

test("only images actually drawn in the body leave the trailing list", () => {
  const files: ChatFile[] = [
    { name: "docs/a.png", version: "1-2", kind: "image", root: 0, imageRefs: ["docs/a.png"] },
    { name: "docs/b.png", version: "1-2", kind: "image", root: 0 },
    { name: "docs/c.png", version: "1-2", kind: "image", root: 0, imageRefs: ["docs/c.png"] },
    { name: "docs/preview/index.html", version: "1-2", kind: "html", root: 0 },
  ];
  const text = "![A](docs/a.png)\n\n```\n![C](docs/c.png)\n```";

  const { images, rest } = splitInlineImages("w1:p1", text, files);

  // 本文の表記から配信 URL を引ける。押したときのダイアログが使う。
  expect(images.get("docs/a.png")).toEqual({
    url: `/api/panes/w1%3Ap1/files?root=0&path=${encodeURIComponent("docs/a.png")}&v=1-2`,
    label: "a.png",
  });
  // 裸のパスだけの画像、フェンスの中で描かれない画像、HTML は末尾に残す。
  expect(rest.map((file) => file.name)).toEqual([
    "docs/b.png",
    "docs/c.png",
    "docs/preview/index.html",
  ]);
  expect(splitInlineImages("w1:p1", "", undefined)).toEqual({ images: new Map(), rest: [] });
});

test("a body over the analysis limit keeps every image in the trailing list", () => {
  const files: ChatFile[] = [
    { name: "docs/a.png", version: "1-2", kind: "image", root: 0, imageRefs: ["docs/a.png"] },
  ];
  const text = `![A](docs/a.png)\n${"x".repeat(MARKDOWN_MAX_LENGTH)}`;

  const { images, rest } = splitInlineImages("w1:p1", text, files);

  // 解析しない本文では記法が原文のまま残るので、末尾の一覧からも外さない。
  expect(images.size).toBe(0);
  expect(rest.map((file) => file.name)).toEqual(["docs/a.png"]);
});

test("a page chip and the preview header show the root label", () => {
  // チェックアウトのファイルは既定なので、名前と種別だけで足りる。
  expect(messageFileDisplayName("docs/preview/mock.html", undefined)).toBe("mock.html");
  expect(messageFileKindLabel(undefined)).toBe("HTML");

  // 同じベース名でも、根のラベルがあれば押す前に見分けられる。
  expect(messageFileDisplayName("docs/preview/mock.html", "/tmp")).toBe("mock.html · /tmp");
  expect(messageFileKindLabel("/tmp")).toBe("HTML · /tmp");
  expect(messageFileKindLabel("mock")).toBe("HTML · mock");
});

test("the terminal output is shown until the conversation is readable", () => {
  expect(
    paneBody({ chat: false, blocked: false, failed: false, snapshot, showTerminal: false }),
  ).toEqual({ kind: "output" });
  // 要対応でも、応答待ちが読めなければ端末を見る。
  expect(
    paneBody({ chat: true, blocked: true, failed: false, snapshot, showTerminal: false }),
  ).toEqual({ kind: "output" });
  expect(
    paneBody({ chat: true, blocked: false, failed: true, snapshot: null, showTerminal: false }),
  ).toEqual({ kind: "output" });
});

test("a blocked pane keeps the conversation only while a pending prompt is readable", () => {
  const waiting: ChatSnapshot = {
    ...snapshot,
    pending: { kind: "tool", toolUseId: "t1", tool: "Bash", summary: "touch /tmp/demo" },
  };
  expect(
    paneBody({ chat: true, blocked: true, failed: false, snapshot: waiting, showTerminal: false }),
  ).toEqual({
    kind: "chat",
    snapshot: waiting,
  });
  // カードから「端末出力を見る」を押した間だけ端末へ切り替える。
  expect(
    paneBody({ chat: true, blocked: true, failed: false, snapshot: waiting, showTerminal: true }),
  ).toEqual({
    kind: "output",
  });
});

test("the pending card is shown only while Herdr reports blocked", () => {
  const waiting: ChatSnapshot = {
    ...snapshot,
    pending: { kind: "tool", toolUseId: "t1", tool: "Bash", summary: null },
  };
  // ツールが実行中の間も末尾は tool_use なので、pending だけでは人間待ちと決められない。
  expect(pendingCard(waiting, false)).toBeNull();
  expect(pendingCard(waiting, true)).toEqual(waiting.pending ?? null);
  expect(pendingCard(snapshot, true)).toBeNull();
  expect(pendingCard(null, true)).toBeNull();
});

test("the conversation replaces the skeleton once a snapshot arrives", () => {
  expect(
    paneBody({ chat: true, blocked: false, failed: false, snapshot: null, showTerminal: false }),
  ).toEqual({ kind: "skeleton" });
  expect(
    paneBody({ chat: true, blocked: false, failed: false, snapshot, showTerminal: false }),
  ).toEqual({ kind: "chat", snapshot });
});

test("an empty conversation is still a conversation", () => {
  expect(
    paneBody({ chat: true, blocked: false, failed: false, snapshot: empty, showTerminal: false }),
  ).toEqual({ kind: "chat", snapshot: empty });
});

test("a new session immediately hides the old history and usage without changing the snapshot", () => {
  const previous: ChatSnapshot = {
    ...snapshot,
    truncated: true,
    context: { tokens: 40_000, window: 200_000 },
    usage: { input: 39_000, output: 1_000, cacheRead: 0, cacheWrite: 0, reasoning: null },
    compaction: { at: 900, tokensBefore: 50_000, summary: "previous", index: 0 },
    pending: { kind: "tool", toolUseId: "t1", tool: "Bash", summary: null },
  };
  const original = structuredClone(previous);
  // 応答待ちも literal で作るので、/new の直後はカードを出さない。
  expect(newSessionSnapshot(previous)).toEqual({
    ...empty,
    truncated: false,
    context: null,
    compaction: null,
  });
  expect(previous).toEqual(original);
});

test("a new session can be displayed before any conversation has loaded", () => {
  expect(newSessionSnapshot(null)).toEqual({
    etag: "",
    messages: [],
    model: null,
    effort: null,
    truncated: false,
    context: null,
    compaction: null,
  });
});

test("unchanged or unavailable history cannot bring back the previous conversation", () => {
  const reset = newSessionReset(snapshot, 2_000);
  expect(newSessionPending(reset, snapshot)).toBe(true);
  expect(newSessionPending(reset, null)).toBe(true);
});

test("a changed etag is not a new session while any old message remains", () => {
  const previous: ChatSnapshot = {
    ...snapshot,
    messages: [...snapshot.messages, { id: "a1", role: "agent", text: "reply", at: 1_100 }],
  };
  const reset = newSessionReset(previous, 2_000);
  expect(newSessionPending(reset, { ...previous, etag: "metadata-change" })).toBe(true);
  expect(newSessionPending(reset, { ...snapshot, etag: "older-read" })).toBe(true);
  expect(
    newSessionPending(reset, {
      ...snapshot,
      etag: "appended",
      messages: [...snapshot.messages, { id: "u2", role: "user", text: "later", at: 2_100 }],
    }),
  ).toBe(true);
});

test("an empty or already started new session replaces the local new view", () => {
  const reset = newSessionReset(snapshot, 2_000);
  expect(newSessionPending(reset, { ...empty, etag: "new-empty" })).toBe(false);
  expect(
    newSessionPending(reset, {
      ...snapshot,
      etag: "new-started",
      messages: [{ id: "u2", role: "user", text: "next conversation", at: 2_100 }],
    }),
  ).toBe(false);
});

test("the old compaction alone still belongs to the previous session", () => {
  const previous: ChatSnapshot = {
    ...empty,
    compaction: { at: 900, tokensBefore: 50_000, summary: "previous", index: 0 },
  };
  const reset = newSessionReset(previous, 2_000);
  expect(newSessionPending(reset, { ...previous, etag: "metadata-change" })).toBe(true);
  expect(newSessionPending(reset, { ...empty, etag: "new-empty" })).toBe(false);
});

test("without an initial snapshot, history predating the command stays hidden", () => {
  const reset = newSessionReset(null, 2_000);
  expect(newSessionPending(reset, snapshot)).toBe(true);
  expect(
    newSessionPending(reset, {
      ...empty,
      compaction: { at: 900, tokensBefore: 50_000, summary: "previous", index: 0 },
    }),
  ).toBe(true);
  expect(newSessionPending(reset, empty)).toBe(false);
  expect(
    newSessionPending(reset, {
      ...snapshot,
      messages: [{ id: "u2", role: "user", text: "next conversation", at: 2_100 }],
    }),
  ).toBe(false);
});

test("model and effort are shown only when the session has them", () => {
  expect(agentInfo(null)).toBeNull();
  expect(agentInfo({ ...snapshot, model: null, effort: null })).toBeNull();
  expect(agentInfo(snapshot)).toEqual({ model: "pi-large", effort: "high" });
  expect(agentInfo({ ...snapshot, model: "pi-large", effort: null })).toEqual({
    model: "pi-large",
    effort: null,
  });
  expect(agentInfo({ ...snapshot, model: null, effort: "low" })).toEqual({
    model: null,
    effort: "low",
  });
});

test("token counts are shortened the way pi's footer does", () => {
  expect(formatTokens(0)).toBe("0");
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(1_000)).toBe("1.0k");
  expect(formatTokens(9_999)).toBe("10.0k");
  expect(formatTokens(122_600)).toBe("123k");
  expect(formatTokens(999_999)).toBe("1000k");
  expect(formatTokens(1_000_000)).toBe("1.0M");
  expect(formatTokens(1_050_000)).toBe("1.1M");
  expect(formatTokens(12_345_678)).toBe("12M");
});

test("the percent is derived from tokens and window, one decimal below 10%", () => {
  expect(contextPercent({ tokens: 122_600, window: 1_000_000 })).toBeCloseTo(12.26);
  expect(contextPercent({ tokens: null, window: 1_000_000 })).toBeNull();
  expect(contextPercent({ tokens: 122_600, window: null })).toBeNull();
  // window 0 は Infinity になる。BFF はこの形を送らないが、描画側でも作らない。
  expect(contextPercent({ tokens: 122_600, window: 0 })).toBeNull();
});

test("the meter turns to attention only above 70%", () => {
  expect(contextTone(0)).toBe("secondary");
  expect(contextTone(70)).toBe("secondary");
  expect(contextTone(70.1)).toBe("attention");
  expect(contextTone(140)).toBe("attention");
});

test("the fill stays inside the track while the number may pass 100%", () => {
  expect(contextFill(12.3)).toBe(12.3);
  expect(contextFill(-5)).toBe(0);
  expect(contextFill(140)).toBe(100);
});

// Issue #45 の表と同じ並び。材料が増える順に、広い表現と狭い表現を固定する。
const contextRows: Array<{ context: ChatContext; wide: string | null; narrow: string | null }> = [
  {
    context: { tokens: 122_600, window: 1_000_000 },
    wide: "123k/1.0M (12.3%)",
    narrow: "12.3%",
  },
  { context: { tokens: null, window: 1_000_000 }, wide: "?/1.0M", narrow: "?" },
  { context: { tokens: 122_600, window: null }, wide: "123k/?", narrow: "123k" },
  { context: { tokens: null, window: null }, wide: null, narrow: null },
];

test("the context text falls back to the material it has in each width", () => {
  for (const row of contextRows) {
    expect(contextText(row.context, false)).toBe(row.wide);
    expect(contextText(row.context, true)).toBe(row.narrow);
  }
});

test("the meter is drawn only when there is something to show", () => {
  expect(contextMeter(null)).toBeNull();
  expect(contextMeter({ tokens: null, window: null })).toBeNull();
  expect(contextMeter({ tokens: 900_000, window: 1_000_000 })).toEqual({
    wide: "900k/1.0M (90.0%)",
    narrow: "90.0%",
    percent: 90,
    fill: 90,
    tone: "attention",
  });
  // window が分からないときは percent もバーも無い。
  expect(contextMeter({ tokens: 122_600, window: null })).toEqual({
    wide: "123k/?",
    narrow: "123k",
    percent: null,
    fill: 0,
    tone: "secondary",
  });
});

test("context details show exact values and unknown usage parts", () => {
  expect(
    contextDetails(
      { tokens: 81_900, window: 200_000 },
      {
        input: 11_000,
        output: 900,
        cacheRead: 70_000,
        cacheWrite: null,
        reasoning: null,
      },
    ),
  ).toEqual([
    ["使用量", "81,900"],
    ["設定枠", "200,000"],
    ["入力", "11,000"],
    ["出力", "900"],
    ["キャッシュ読取", "70,000"],
    ["キャッシュ書込", "不明"],
  ]);
  expect(contextDetails({ tokens: null, window: 100_000 }, undefined)).toEqual([
    ["使用量", "不明"],
    ["設定枠", "100,000"],
  ]);
  expect(
    contextDetails(
      { tokens: 8, window: null },
      {
        input: 1,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        reasoning: 4,
      },
    ).at(-1),
  ).toEqual(["推論", "4"]);
});

test("the compaction line says how much was compressed", () => {
  expect(compactionLabel({ at: 1_000, tokensBefore: 212_959, summary: "so far", index: 0 })).toBe(
    "212,959 tokens から圧縮",
  );
  expect(compactionLabel({ at: 1_000, tokensBefore: 950, summary: "so far", index: 0 })).toBe(
    "950 tokens から圧縮",
  );
  // 数を出せないときは、圧縮だけを伝える。
  expect(compactionLabel({ at: 1_000, tokensBefore: null, summary: "so far", index: 0 })).toBe(
    "圧縮",
  );
});

const pending: PendingMessage = {
  id: "pending-1",
  role: "user",
  text: "  steer  ",
  at: 1_000_000,
  from: 990_000,
  waiting: true,
  after: 0,
  command: false,
};

test("the latest user message sets the pending baseline", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "old", at: 100 },
    { id: "a1", role: "agent", text: "reply", at: 200 },
    { id: "u2", role: "user", text: "last", at: 300 },
  ];
  expect(latestUserAt(messages)).toBe(300);
  expect(latestUserAt([])).toBe(0);
  expect(latestUserAt(messages.filter((message) => message.role === "agent"))).toBe(0);
});

test("a pending message is confirmed by a new user message after its baseline", () => {
  expect(
    isPendingConfirmed(pending, [{ id: "m2", role: "user", text: "steer", at: pending.from + 1 }]),
  ).toBe(true);
  expect(
    isPendingConfirmed(pending, [{ id: "m2", role: "user", text: "steer", at: pending.from }]),
  ).toBe(false);
  expect(
    isPendingConfirmed(pending, [{ id: "m2", role: "agent", text: "steer", at: pending.from + 1 }]),
  ).toBe(false);
  // ask_user の回答として合成された user 行は、通常送信の確定に使わない。
  expect(
    isPendingConfirmed(pending, [
      { id: "m2", role: "user", text: "steer", at: pending.from + 1, synthetic: true },
    ]),
  ).toBe(false);
  expect(isPendingConfirmed(pending, [])).toBe(false);
});

test("an answer echo leaves only when the same question is synthesized", () => {
  const answer: PendingMessage = {
    ...pending,
    waiting: false,
    text: "青",
    answer: true,
    toolUseId: "q2",
    question: "Q2",
  };
  expect(
    isPendingConfirmed(answer, [
      {
        id: "a2",
        role: "user",
        text: " 青 ",
        at: pending.from + 1,
        synthetic: true,
        askId: "q2",
      },
    ]),
  ).toBe(true);
  // TUI が別の回答を採用しても、同じ質問の結果なら畳む。
  expect(
    isPendingConfirmed(answer, [
      {
        id: "a2",
        role: "user",
        text: "赤",
        at: pending.from + 1,
        synthetic: true,
        askId: "q2",
      },
    ]),
  ).toBe(true);
  // 別の質問の合成回答では畳まない。
  expect(
    isPendingConfirmed(answer, [
      {
        id: "a1",
        role: "user",
        text: "赤",
        at: pending.from + 1,
        synthetic: true,
        askId: "q1",
      },
    ]),
  ).toBe(false);
  // 同じ本文の通常 user 発話では畳まない。
  expect(
    isPendingConfirmed(answer, [{ id: "a2", role: "user", text: "青", at: pending.from + 1 }]),
  ).toBe(false);
});

test("an answer echo from an old mypi falls back to the question text", () => {
  const answer: PendingMessage = {
    ...pending,
    waiting: false,
    text: "Blue",
    answer: true,
    question: "Q2",
  };
  expect(
    isPendingConfirmed(answer, [
      {
        id: "ask:old-q1:question",
        role: "agent",
        text: "Q1",
        at: pending.from + 1,
        synthetic: true,
      },
      {
        id: "ask:old-q1:answer",
        role: "user",
        text: "Red",
        at: pending.from + 2,
        synthetic: true,
      },
    ]),
  ).toBe(false);
  const oldAnswer = [
    {
      id: "ask:old-q2:question",
      role: "agent" as const,
      text: "Q2",
      at: pending.from + 1,
      synthetic: true as const,
    },
    {
      id: "ask:old-q2:answer",
      role: "user" as const,
      text: "Blue",
      at: pending.from + 2,
      synthetic: true as const,
    },
  ];
  expect(isPendingConfirmed(answer, oldAnswer)).toBe(true);
  // 同じ質問がまだ pending の間は、古い結果の推測で消さない。
  expect(isPendingConfirmed({ ...answer, toolUseId: "q2" }, oldAnswer, "q2")).toBe(false);
  expect(isPendingConfirmed({ ...answer, toolUseId: "q2" }, oldAnswer, "other")).toBe(true);
});

test("old mypi batch answers pair by synthetic id, not adjacency", () => {
  const answer: PendingMessage = {
    ...pending,
    waiting: false,
    text: "New",
    answer: true,
    toolUseId: "q2",
    question: "Same?",
  };
  const batch = [
    {
      id: "ask:k1:question",
      role: "agent" as const,
      text: "Same?",
      at: pending.from - 10,
      synthetic: true as const,
    },
    {
      id: "ask:k2:question",
      role: "agent" as const,
      text: "Same?",
      at: pending.from - 10,
      synthetic: true as const,
    },
    {
      id: "ask:k1:answer",
      role: "user" as const,
      text: "Old",
      at: pending.from - 1,
      synthetic: true as const,
    },
    {
      id: "ask:k2:answer",
      role: "user" as const,
      text: "New",
      at: pending.from + 1,
      synthetic: true as const,
    },
  ];
  expect(isPendingConfirmed(answer, batch, "q2")).toBe(false);
  expect(isPendingConfirmed(answer, batch)).toBe(true);
  // 別の質問の古い回答だけでは消さない。
  expect(isPendingConfirmed(answer, batch.slice(0, 3))).toBe(false);
});

test("an answer echo is released when its question is no longer pending", () => {
  const answer: PendingMessage = {
    ...pending,
    waiting: false,
    answer: true,
    toolUseId: "q1",
  };
  expect(answerEchoReleased(answer, "q1")).toBe(false);
  expect(answerEchoReleased(answer, "q2")).toBe(true);
  expect(answerEchoReleased(answer, undefined)).toBe(true);
  // 通常の送信控えは pending の質問 ID を持たないので対象外。
  expect(answerEchoReleased({ ...pending, toolUseId: "q1" }, "q2")).toBe(false);

  // 一度解放した期限は、次の質問が来ても延びない。
  const released = { ...answer, answerReleaseAt: 5_000 };
  expect(answerEchoReleaseAt(released, "q2", 9_000)).toBe(5_000);
  expect(answerEchoReleaseAt({ ...answer, answerReleaseAt: undefined }, "q2", 9_000)).toBe(
    9_000 + ANSWER_ECHO_GRACE_MS,
  );
  // pending が同じ質問に戻ったら期限を外す。
  expect(answerEchoReleaseAt(released, "q1", 9_000)).toBeUndefined();
});

test("an echo whose pane never started working expires after the turn grace", () => {
  const idle: PendingMessage = { ...pending, waiting: false, at: 1_000_000 };
  expect(idleEchoExpired(idle, idle.at + PENDING_TURN_GRACE_MS - 1)).toBe(false);
  expect(idleEchoExpired(idle, idle.at + PENDING_TURN_GRACE_MS)).toBe(true);
  // 実行中に送った echo はターンの終了で畳む。猶予では消さない。
  expect(idleEchoExpired({ ...idle, waiting: true }, idle.at + 60_000)).toBe(false);
});

test("a command echo leaves only when the session records the same text", () => {
  const command: PendingMessage = { ...pending, waiting: false, text: "/reload", command: true };
  // 次の通常のメッセージでは消さない。コマンドの控えを履歴に残すため。
  expect(
    isPendingConfirmed(command, [
      { id: "m2", role: "user", text: "next message", at: pending.from + 1 },
    ]),
  ).toBe(false);
  expect(
    isPendingConfirmed(command, [
      { id: "m2", role: "user", text: " /reload ", at: pending.from + 1 },
    ]),
  ).toBe(true);
  // ask_user の合成回答が同じ文言でも、コマンド控えは消さない。
  expect(
    isPendingConfirmed(command, [
      {
        id: "m2",
        role: "user",
        text: "/reload",
        at: pending.from + 1,
        synthetic: true,
      },
    ]),
  ).toBe(false);
  // 送信前からあった同じ文言は、そのコマンドの発話ではない。
  expect(
    isPendingConfirmed(command, [{ id: "m2", role: "user", text: "/reload", at: pending.from }]),
  ).toBe(false);
});

test("a command echo stays after the messages it was sent after", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "first", at: 100 },
    { id: "a1", role: "agent", text: "reply", at: 200 },
  ];
  const command: PendingMessage = {
    ...pending,
    id: "command-1",
    text: "/reload",
    at: 300,
    waiting: false,
    after: 2,
    command: true,
  };
  // 次の発話が届いても、コマンドは送った位置（2 件の後ろ）に残る。
  const rows = chatRows(
    [...messages, { id: "u2", role: "user", text: "next", at: 400 }],
    [command],
  );
  expect(rows.map((row) => `${row.echo}:${row.message.id}`)).toEqual([
    "none:u1",
    "none:a1",
    "command:command-1",
    "none:u2",
  ]);
  expect(rows[2]!.seen).toBe(2);
});

test("commands keep their send order and pending echoes stay at the end", () => {
  const messages: ChatMessage[] = [{ id: "u1", role: "user", text: "first", at: 100 }];
  const first: PendingMessage = {
    ...pending,
    id: "c1",
    command: true,
    waiting: false,
    after: 0,
    at: 200,
  };
  const second: PendingMessage = {
    ...pending,
    id: "c2",
    command: true,
    waiting: false,
    after: 0,
    at: 300,
  };
  const tail: PendingMessage = { ...pending, id: "p1" };
  expect(
    chatRows(messages, [first, second, tail]).map((row) => `${row.echo}:${row.message.id}`),
  ).toEqual(["command:c1", "command:c2", "none:u1", "pending:p1"]);
});

test("an anchor past the loaded messages falls back to the end", () => {
  const messages: ChatMessage[] = [{ id: "u1", role: "user", text: "first", at: 100 }];
  const command: PendingMessage = { ...pending, id: "c1", command: true, after: 9 };
  expect(chatRows(messages, [command]).map((row) => row.message.id)).toEqual(["u1", "c1"]);
});

test("the compaction line sits at its message boundary", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "first", at: 100 },
    { id: "u2", role: "user", text: "second", at: 200 },
  ];
  expect(compactionInsertIndex([], null)).toBeNull();
  expect(compactionInsertIndex(chatRows(messages, []), 1)).toBe(1);
  // 末尾の圧縮は送信中の echo より前。
  const tail: PendingMessage = { ...pending, id: "p1" };
  expect(compactionInsertIndex(chatRows(messages, [tail]), 2)).toBe(2);
  // 同じ境界のコマンドの控えは、圧縮より前。
  const command: PendingMessage = {
    ...pending,
    id: "c1",
    command: true,
    waiting: false,
    after: 2,
  };
  expect(compactionInsertIndex(chatRows(messages, [command, tail]), 2)).toBe(3);
});

test("a running compaction echo stays after the messages and before later echoes", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "first", at: 100 },
    { id: "a1", role: "agent", text: "reply", at: 200 },
  ];
  const command: PendingMessage = {
    ...pending,
    id: "c1",
    command: true,
    waiting: false,
    after: 2,
    at: 250,
  };
  const later: PendingMessage = { ...pending, id: "p1", waiting: false, at: 400 };
  const rows = chatRows(messages, [command, later]);
  expect(echoInsertIndex(rows, 300)).toBe(3);
  expect(echoInsertIndex(rows, 500)).toBe(rows.length);
  // メッセージの前に差し込まれたコマンドの控えより後ろに置く。
  const anchored: PendingMessage = {
    ...pending,
    id: "c2",
    command: true,
    waiting: false,
    after: 1,
    at: 50,
  };
  expect(echoInsertIndex(chatRows(messages, [anchored]), 10)).toBe(3);
});

test("maps a resolved link to the same destination as the chip", () => {
  const links = messageLinks("w1:p1", [
    { href: "docs/mock.html", name: "docs/mock.html", version: "1-2", kind: "html", root: 0 },
    { href: "./shot.png", name: "docs/shot.png", version: "3-4", kind: "image", root: 1 },
    { href: "src/app.ts", name: "src/app.ts", version: "5-6", kind: "text", root: 0 },
  ]);

  // HTML はチップと同じプレビュー。画像はチップと同じ拡大ダイアログの配信 URL。
  expect(links?.get("docs/mock.html")).toEqual({
    kind: "html",
    url: "/api/panes/w1%3Ap1/preview/0/docs/mock.html",
    file: { name: "docs/mock.html", version: "1-2", kind: "html", root: 0 },
  });
  expect(links?.get("./shot.png")?.url).toBe(
    `/api/panes/w1%3Ap1/files?root=1&path=${encodeURIComponent("docs/shot.png")}&v=3-4`,
  );
  // テキストは本文のリンクから新しいタブで開く。
  expect(links?.get("src/app.ts")).toEqual({
    kind: "text",
    url: "/api/panes/w1%3Ap1/preview/0/src/app.ts?raw=1",
  });
  expect(messageLinks("w1:p1", undefined)).toBeUndefined();
  expect(messageLinks("w1:p1", [])).toBeUndefined();
});

test("the cache expiry counts down in minutes and seconds", () => {
  const now = 1_000_000;
  expect(cacheView(now + 42 * 60_000 + 18_000, now)).toEqual({
    expired: false,
    wide: "42:18",
    narrow: "42m",
  });
  // 1 分未満は秒で出す。切り上げて、満了前に 0 を出さない。
  expect(cacheView(now + 42_000, now)).toEqual({ expired: false, wide: "0:42", narrow: "42s" });
  expect(cacheView(now + 500, now)).toEqual({ expired: false, wide: "0:01", narrow: "1s" });
});

test("an expired or unknown cache expiry is shown as expired only when known", () => {
  const now = 1_000_000;
  expect(cacheView(now, now)).toEqual({ expired: true, wide: "切れ", narrow: "切れ" });
  expect(cacheView(now - 1, now)).toEqual({ expired: true, wide: "切れ", narrow: "切れ" });
  expect(cacheView(null, now)).toBeNull();
  expect(cacheView(undefined, now)).toBeNull();
  expect(cacheView(Number.NaN, now)).toBeNull();
});

test("a new conversation hides the old cache expiry", () => {
  const previous: ChatSnapshot = {
    ...snapshot,
    cacheExpiresAt: 9_999_999,
  };
  expect(newSessionSnapshot(previous)).toEqual({
    etag: "abc",
    messages: [],
    model: "pi-large",
    effort: "high",
    truncated: false,
    context: null,
    compaction: null,
  });
});
