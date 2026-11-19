import { type AnswerRequest, composeAnswer } from "../shared/answer";
import type { ChatPending, SessionChatClient } from "./chat/contract";
import { MAX_TEXT_BYTES, type PaneClient } from "./herdr/panes";

// Esc でダイアログを閉じると、CLI は 0.5 秒以内に tool_result を書く（実機 2.1.328）。読む間隔と
// 待つ上限は、その 6 倍まで見込む。上限までに現れなければ、本文は送らない。
const POLL_INTERVAL_MS = 100;
const SETTLE_TIMEOUT_MS = 3_000;

// 同じ要求の再送（二重タップ、応答を取りこぼした再試行）を 200 にしておく間。
const DONE_TTL_MS = 30_000;

export type AnswerOutcome =
  | { ok: true }
  // 400: 回答が質問と合わない・空。409: 待ちが無い・別の質問・処理中。413: 本文が長い。
  // 502: Herdr か会話の取得に失敗した、または Esc が効いたと確かめられなかった。
  | { ok: false; status: 400 | 409 | 413 | 502; error: string };

export type AnswerInput = {
  paneId: string;
  sessionId: string;
  // Herdr の状態。blocked のときだけ答えられる。
  blocked: boolean;
  request: AnswerRequest;
};

type Clients = {
  panes: Pick<PaneClient, "sendKeys" | "send">;
  chat: SessionChatClient;
};

export type QuestionAnswerer = ReturnType<typeof createQuestionAnswerer>;

// AskUserQuestion には Esc で閉じ、選んだ内容を通常のユーザー発言として送る（ADR 0099）。
// キー操作でフォームを再現しない。会話の正はセッションなので、画面は読まず、閉じたことは
// transcript に tool_result が現れて pending が消えたことで知る。
export function createQuestionAnswerer(
  clients: Clients,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    settleTimeoutMs?: number;
    doneTtlMs?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const settleTimeoutMs = options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
  const doneTtlMs = options.doneTtlMs ?? DONE_TTL_MS;

  // ペインごとに 1 本。同じ toolUseId の要求は同じ結果を待ち、別の要求は断る。
  const inFlight = new Map<string, { toolUseId: string; result: Promise<AnswerOutcome> }>();
  // 完了した要求を短く覚える。完了後は blocked でも pending でもないので、この記録が無いと
  // 再送が 409 になる。pending の有無とは別に、toolUseId で判定する。
  const done = new Map<string, { toolUseId: string; until: number }>();

  const run = async (input: AnswerInput): Promise<AnswerOutcome> => {
    const { paneId, sessionId, blocked, request } = input;
    if (!blocked) return conflict("not_waiting");

    const first = await readPending(clients.chat, sessionId);
    if (first === "failed") return failure("pending_unavailable");
    const question = questionOf(first, request.toolUseId);
    if (question === null) return conflict("not_waiting");

    // 質問文は pending のものを使い、クライアントの改変を防ぐ。
    const body = composeAnswer(question.questions, request.answers);
    if (body === null) return { ok: false, status: 400, error: "invalid_answer" };
    if (new TextEncoder().encode(body).length > MAX_TEXT_BYTES) {
      return { ok: false, status: 413, error: "answer_too_long" };
    }

    try {
      await clients.panes.sendKeys({ paneId, keys: ["esc"] });
    } catch {
      return failure("close_failed");
    }

    const settled = await waitUntilResolved(sessionId, request.toolUseId);
    if (settled !== "resolved") {
      return settled === "replaced" ? conflict("question_changed") : failure(settled);
    }

    try {
      await clients.panes.send({ paneId, text: body, submit: true });
    } catch {
      return failure("send_failed");
    }
    return { ok: true };
  };

  // pending から toolUseId が消えるまで待つ。tool_result の中身（拒否かどうか）は見ない。
  // 別の質問に変わったら、その回答として本文を送らない。
  const waitUntilResolved = async (
    sessionId: string,
    toolUseId: string,
  ): Promise<"resolved" | "replaced" | "pending_unavailable" | "close_timeout"> => {
    const deadline = now() + settleTimeoutMs;
    for (;;) {
      await sleep(pollIntervalMs);
      const pending = await readPending(clients.chat, sessionId);
      if (pending === "failed") return "pending_unavailable";
      if (pending === undefined) return "resolved";
      if (pending.toolUseId !== toolUseId) return "replaced";
      if (now() >= deadline) return "close_timeout";
    }
  };

  return {
    async answer(input: AnswerInput): Promise<AnswerOutcome> {
      const { paneId, request } = input;
      const finished = done.get(paneId);
      if (finished !== undefined) {
        if (finished.until > now() && finished.toolUseId === request.toolUseId) return { ok: true };
        if (finished.until <= now()) done.delete(paneId);
      }

      const running = inFlight.get(paneId);
      if (running !== undefined) {
        return running.toolUseId === request.toolUseId ? running.result : conflict("in_progress");
      }

      const result = run(input);
      inFlight.set(paneId, { toolUseId: request.toolUseId, result });
      try {
        const outcome = await result;
        if (outcome.ok)
          done.set(paneId, { toolUseId: request.toolUseId, until: now() + doneTtlMs });
        return outcome;
      } finally {
        if (inFlight.get(paneId)?.result === result) inFlight.delete(paneId);
      }
    },
  };
}

async function readPending(
  chat: SessionChatClient,
  sessionId: string,
): Promise<ChatPending | undefined | "failed"> {
  try {
    return (await chat.snapshot(sessionId)).pending;
  } catch {
    return "failed";
  }
}

function questionOf(
  pending: ChatPending | undefined | "failed",
  toolUseId: string,
): Extract<ChatPending, { kind: "question" }> | null {
  if (pending === undefined || pending === "failed") return null;
  if (pending.kind !== "question" || pending.toolUseId !== toolUseId) return null;
  return pending;
}

function conflict(error: string): AnswerOutcome {
  return { ok: false, status: 409, error };
}

function failure(error: string): AnswerOutcome {
  return { ok: false, status: 502, error };
}
