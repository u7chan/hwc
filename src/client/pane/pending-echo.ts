import type { ChatAttachment, ChatMessage } from "../../server/chat/contract";
import {
  answerEchoReleaseAt,
  idleEchoExpired,
  isPendingConfirmed,
  PENDING_TURN_GRACE_MS,
  type PendingMessage,
} from "../chat";

// ターンが始まらないまま残った控えを捨てるまでの上限。コマンドの控えは、同じ文言が
// セッションに現れるまで残すので対象外にする。
export const PENDING_TIMEOUT_MS = 60_000;

export type PendingEchoInput = {
  text: string;
  at: number;
  from: number;
  waiting: boolean;
  after: number;
  attachments: ChatAttachment[];
  answer?: boolean;
  toolUseId?: string;
};

export type PendingOperation =
  | { kind: "echo"; echo: PendingEchoInput }
  | { kind: "answerFailed"; toolUseId: string; at: number }
  | { kind: "reset" };

// 控えの判定材料。now を引数で受けるのは、reducer の中で実時刻を読ませないため。
export type PendingStep = {
  messages: ChatMessage[];
  activeToolUseId: string | undefined;
  replying: boolean;
  now: number;
  operation?: PendingOperation;
};

export function reducePending(items: PendingMessage[], step: PendingStep): PendingMessage[] {
  return settlePending(applyOperation(items, step.operation), step);
}

export function nextPendingDeadline(
  items: readonly PendingMessage[],
  replying: boolean,
): number | null {
  let next: number | null = null;
  const consider = (at: number) => {
    if (next === null || at < next) next = at;
  };
  for (const item of items) {
    if (item.answerReleaseAt !== undefined) consider(item.answerReleaseAt);
    if (item.waiting || item.command) continue;
    consider(item.at + PENDING_TIMEOUT_MS);
    if (item.answer !== true && !replying) consider(item.at + PENDING_TURN_GRACE_MS);
  }
  return next;
}

function applyOperation(
  items: PendingMessage[],
  operation: PendingOperation | undefined,
): PendingMessage[] {
  if (operation === undefined) return items;
  switch (operation.kind) {
    case "echo":
      return [...items, echoMessage(items.length, operation.echo)];
    case "answerFailed":
      return items.filter(
        (item) =>
          !(
            item.answer === true &&
            item.toolUseId === operation.toolUseId &&
            item.at === operation.at
          ),
      );
    case "reset":
      return [];
  }
}

function echoMessage(index: number, echo: PendingEchoInput): PendingMessage {
  return {
    id: `pending-${echo.at}-${index}`,
    role: "user",
    text: echo.text,
    at: echo.at,
    from: echo.from,
    waiting: echo.waiting,
    after: echo.after,
    command: false,
    ...(echo.attachments.length === 0 ? {} : { attachments: echo.attachments }),
    ...(echo.answer === true ? { answer: true } : {}),
    ...(echo.toolUseId === undefined ? {} : { toolUseId: echo.toolUseId }),
  };
}

// 並び順がそのまま期限の優先順位になる（確定 → 待機の解除 → 回答の期限 → 猶予による
// コマンド化 → 上限による破棄）。猶予を上限より先に見るのは、ターンが始まらなかった送信を
// 捨てずにコマンドとして履歴へ残すため。
function settlePending(items: PendingMessage[], step: PendingStep): PendingMessage[] {
  let changed = false;
  const next: PendingMessage[] = [];
  for (const item of items) {
    if (isPendingConfirmed(item, step.messages)) {
      changed = true;
      continue;
    }
    // 実行中でなくなった待機の控えは、ターンが終わった時点で確定しているはず。
    if (item.waiting && !step.replying) {
      changed = true;
      continue;
    }
    let current = item;
    const releaseAt = answerEchoReleaseAt(item, step.activeToolUseId, step.now);
    if (releaseAt !== item.answerReleaseAt) {
      current = withAnswerReleaseAt(item, releaseAt);
      changed = true;
    }
    if (current.answerReleaseAt !== undefined && current.answerReleaseAt <= step.now) {
      changed = true;
      continue;
    }
    // 送信したのにエージェントが動き出さない控えは、TUI がコマンドとして処理したか、
    // 入力を受け取らなかったもの。コマンドは user 発話を残さないため、セッションを
    // 待っても確定しない。捨てずにコマンド控えへ切り替えて、打った内容を履歴に残す。
    if (
      !current.command &&
      current.answer !== true &&
      !step.replying &&
      idleEchoExpired(current, step.now)
    ) {
      current = { ...current, command: true };
      changed = true;
    }
    if (!current.waiting && !current.command && current.at + PENDING_TIMEOUT_MS <= step.now) {
      changed = true;
      continue;
    }
    next.push(current);
  }
  return changed ? next : items;
}

function withAnswerReleaseAt(item: PendingMessage, releaseAt: number | undefined): PendingMessage {
  if (releaseAt !== undefined) return { ...item, answerReleaseAt: releaseAt };
  const { answerReleaseAt: _released, ...rest } = item;
  return rest;
}
