import { expect, test } from "bun:test";
import type { ChatMessage } from "../../server/chat/contract";
import { ANSWER_ECHO_GRACE_MS, PENDING_TURN_GRACE_MS } from "../chat";
import {
  nextPendingDeadline,
  PENDING_TIMEOUT_MS,
  reducePending,
  type PendingEchoInput,
  type PendingStep,
} from "./pending-echo";

// 控えの時刻は実時間に依らない固定値。reducer は now を引数でしか読まない。
const AT = 1_000_000;

const echo: PendingEchoInput = {
  text: "steer",
  at: AT,
  from: 990_000,
  waiting: true,
  after: 0,
  attachments: [],
};

const step = (over: Partial<PendingStep> = {}): PendingStep => ({
  messages: [],
  activeToolUseId: undefined,
  replying: true,
  now: AT,
  ...over,
});

const echoOf = (over: Partial<PendingEchoInput>, rest: Partial<PendingStep> = {}) =>
  reducePending([], step({ operation: { kind: "echo", echo: { ...echo, ...over } }, ...rest }));

const user = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  role: "user",
  text: "steer",
  at: echo.from + 1,
  ...over,
});

test("a send echo is added at the position it was sent from", () => {
  const list = reducePending([], step({ operation: { kind: "echo", echo } }));
  expect(list).toEqual([
    {
      id: `pending-${AT}-0`,
      role: "user",
      text: "steer",
      at: AT,
      from: echo.from,
      waiting: true,
      after: 0,
      command: false,
    },
  ]);
  // 添付・回答・質問 id は、渡したときだけ持つ。
  const plain = echoOf({ waiting: false })[0]!;
  expect(plain).not.toHaveProperty("attachments");
  expect(plain).not.toHaveProperty("answer");
  expect(plain).not.toHaveProperty("toolUseId");
  const answer = echoOf({
    waiting: false,
    attachments: [{ name: "a.png", size: 1 }],
    answer: true,
    toolUseId: "q1",
  });
  expect(answer[0]).toMatchObject({
    attachments: [{ name: "a.png", size: 1 }],
    answer: true,
    toolUseId: "q1",
  });
  // id は積んだ順。
  const next = reducePending(
    list,
    step({ operation: { kind: "echo", echo: { ...echo, at: AT + 5 } } }),
  );
  expect(next.map((item) => item.id)).toEqual([`pending-${AT}-0`, `pending-${AT + 5}-1`]);
});

test("an echo leaves when the session records a user message after its baseline", () => {
  const list = echoOf({ waiting: false }, { replying: false });
  expect(list).toHaveLength(1);
  // 送信時点の最後の user 発話より後だけを確定とみなす。
  expect(reducePending(list, step({ messages: [user({ at: echo.from })] }))).toHaveLength(1);
  expect(reducePending(list, step({ messages: [user()] }))).toEqual([]);
  // 合成した ask_user の回答では、通常送信の控えを畳まない。
  expect(
    reducePending(list, step({ messages: [user({ synthetic: true })], activeToolUseId: "q1" })),
  ).toHaveLength(1);
});

test("a waiting echo leaves when the pane stops working", () => {
  const list = reducePending([], step({ operation: { kind: "echo", echo } }));
  expect(list).toHaveLength(1);
  // 実行中のまま 60 秒を過ぎても、待機の控えは残す。
  expect(reducePending(list, step({ now: AT + PENDING_TIMEOUT_MS + 1 }))).toHaveLength(1);
  expect(reducePending(list, step({ replying: false, now: AT + 1 }))).toEqual([]);
});

test("an echo whose turn never started becomes a command after the grace", () => {
  const list = echoOf({ waiting: false }, { replying: false });
  expect(
    reducePending(list, step({ replying: false, now: AT + PENDING_TURN_GRACE_MS - 1 }))[0]!.command,
  ).toBe(false);
  const command = reducePending(list, step({ replying: false, now: AT + PENDING_TURN_GRACE_MS }));
  expect(command[0]!.command).toBe(true);
  // 実行中はコマンドに切り替えない。
  expect(
    reducePending(list, step({ replying: true, now: AT + PENDING_TURN_GRACE_MS }))[0]!.command,
  ).toBe(false);
});

test("a command echo survives the pending timeout until the session records it", () => {
  const command = reducePending(
    echoOf({ waiting: false }, { replying: false }),
    step({ replying: false, now: AT + PENDING_TURN_GRACE_MS }),
  );
  expect(command[0]!.command).toBe(true);
  expect(reducePending(command, step({ now: AT + PENDING_TIMEOUT_MS + 1 }))).toHaveLength(1);
  // 同じ文言の user 発話が届いたら畳む。
  expect(reducePending(command, step({ messages: [user({ text: "steer" })] }))).toEqual([]);
  // 実行中のままコマンドにもならなかった控えは、60 秒で捨てる。
  const idle = echoOf({ waiting: false }, { replying: true });
  expect(reducePending(idle, step({ now: AT + PENDING_TIMEOUT_MS }))).toEqual([]);
});

test("a failed answer drops only that echo, without waiting for the grace", () => {
  const list = [
    ...echoOf({ at: AT, waiting: false, answer: true, toolUseId: "q1" }),
    ...echoOf({ at: AT + 10, waiting: false, answer: true, toolUseId: "q1" }),
    ...echoOf({ at: AT + 20, waiting: false, answer: true, toolUseId: "q2" }),
    ...echoOf({ at: AT + 30, waiting: false }),
  ];
  expect(list).toHaveLength(4);
  const next = reducePending(
    list,
    step({ replying: false, operation: { kind: "answerFailed", toolUseId: "q1", at: AT } }),
  );
  // 同じ質問でも、押した時点の控えだけを取り消す。
  expect(next.map((item) => item.at)).toEqual([AT + 10, AT + 20, AT + 30]);
});

test("an answer echo is released once its question is gone and leaves after the grace", () => {
  const list = echoOf(
    { waiting: false, answer: true, toolUseId: "q1" },
    { replying: false, activeToolUseId: "q1" },
  );
  expect(list[0]!.answerReleaseAt).toBeUndefined();
  // 質問が pending の間は期限を持たない。
  expect(
    reducePending(list, step({ activeToolUseId: "q1", now: AT + 500 }))[0]!.answerReleaseAt,
  ).toBeUndefined();
  // 質問が外れた時点で一度だけ期限を付ける。
  const released = reducePending(list, step({ now: AT + 1_000 }));
  expect(released[0]!.answerReleaseAt).toBe(AT + 1_000 + ANSWER_ECHO_GRACE_MS);
  // 次の質問が来ても延ばさない。
  expect(
    reducePending(released, step({ activeToolUseId: "q2", now: AT + 1_500 }))[0]!.answerReleaseAt,
  ).toBe(AT + 1_000 + ANSWER_ECHO_GRACE_MS);
  // 同じ質問が pending に戻ったら外す。
  expect(
    reducePending(released, step({ activeToolUseId: "q1", now: AT + 1_200 }))[0]!.answerReleaseAt,
  ).toBeUndefined();
  // 期限を過ぎたら捨てる。
  expect(reducePending(released, step({ now: AT + 1_000 + ANSWER_ECHO_GRACE_MS }))).toEqual([]);
});

test("a synthesized answer confirms the echo of that question", () => {
  const list = echoOf({ waiting: false, answer: true, toolUseId: "q1" }, { replying: false });
  const synthetic = (askId: string): ChatMessage =>
    user({ text: "青", synthetic: true, askId, id: `ask:${askId}:answer` });
  expect(reducePending(list, step({ messages: [synthetic("q1")], activeToolUseId: "q1" }))).toEqual(
    [],
  );
  // 別の質問の合成回答では畳まない。
  const other = reducePending(list, step({ messages: [synthetic("q2")], activeToolUseId: "q1" }));
  expect(other).toHaveLength(1);
  // 同じ質問の結果なら、TUI が別の回答を採用しても畳む。
  expect(
    reducePending(
      list,
      step({
        messages: [user({ text: "赤", synthetic: true, askId: "q1" })],
        activeToolUseId: "q1",
      }),
    ),
  ).toEqual([]);
});

test("the new-session reset drops every echo", () => {
  const list = echoOf({ waiting: false });
  expect(reducePending(list, step({ operation: { kind: "reset" } }))).toEqual([]);
});

test("an unchanged list is returned as it is", () => {
  const list = echoOf({ waiting: false });
  // 同じ控えなら参照を保つ。呼び出し側（タイマーの hook）が再描画を繰り返さないため。
  expect(reducePending(list, step({ now: AT + 1 }))).toBe(list);
});

test("the next deadline is the earliest expiry among the echoes", () => {
  expect(nextPendingDeadline([], false)).toBeNull();
  // 実行中の待機は期限を持たない。
  const waiting = echoOf({}, { replying: true })[0]!;
  expect(nextPendingDeadline([waiting], true)).toBeNull();
  // ターンが始まらない控えは、猶予の終わりにコマンドへ切り替わる。
  const idle = echoOf({ waiting: false }, { replying: false })[0]!;
  expect(nextPendingDeadline([idle], false)).toBe(idle.at + PENDING_TURN_GRACE_MS);
  // 実行中は猶予を切らない。残るのは 60 秒の上限。
  expect(nextPendingDeadline([idle], true)).toBe(idle.at + PENDING_TIMEOUT_MS);
  // 回答の控えは、質問が外れた時点の期限が先に来る。
  const released = { ...idle, answer: true as const, toolUseId: "q1", answerReleaseAt: AT + 1_000 };
  expect(nextPendingDeadline([idle, released], false)).toBe(AT + 1_000);
  // コマンドの控えは期限を持たない。同じ文言が届くまで残す。
  expect(nextPendingDeadline([{ ...idle, command: true }], false)).toBeNull();
});
