import type { AnswerRequest, QuestionAnswer } from "../shared/answer";
import {
  type AskAnswer,
  type AskPending,
  askText,
  readAnswerId,
  readAsk,
  writeAskAnswer,
} from "./chat/pi-ask";

export type AskAnswerOutcome =
  | { ok: true }
  // 400: 回答が質問と合わない。409: 待ちが無い・別の質問・処理中・回答済み。
  // 502: answer を書けなかった。
  | { ok: false; status: 400 | 409 | 502; error: string };

export type AskAnswerInput = {
  paneId: string;
  // セッション path は BFF がペイン id から引く。クライアントからは受け取らない。
  sessionPath: string;
  // Herdr の状態。blocked のときだけ答えられる。
  blocked: boolean;
  request: AnswerRequest;
};

export type AskAnswerer = ReturnType<typeof createAskAnswerer>;

type Clients = {
  readPending?: (sessionPath: string) => Promise<AskPending | null>;
  readAnswerId?: (sessionPath: string) => Promise<string | null>;
  writeAnswer?: (sessionPath: string, id: string, answer: AskAnswer) => Promise<void>;
};

// mypi の ask_user にはファイルで答える。キーも本文も送らない
// （docs/adr/pi-integration.md / docs/adr/agent-input.md）。
export function createAskAnswerer(clients: Clients = {}) {
  const readPending = clients.readPending ?? readAsk;
  const readExisting = clients.readAnswerId ?? readAnswerId;
  const writeAnswer = clients.writeAnswer ?? writeAskAnswer;

  // 判定から書き込みまでをペインごとに直列化する。完了した id は覚えない。覚えると、
  // BFF を再起動したあとに同じ質問へ 2 回目を書けてしまう（正は answer ファイル）。
  const inFlight = new Set<string>();

  const run = async (input: AskAnswerInput): Promise<AskAnswerOutcome> => {
    const { sessionPath, blocked, request } = input;
    if (!blocked) return conflict("not_waiting");

    const pending = await readPending(sessionPath);
    if (pending === null || pending.id !== request.toolUseId) return conflict("not_waiting");
    const answer = answerOf(pending, request.answers);
    if (answer === null) return { ok: false, status: 400, error: "invalid_answer" };

    // 既存の answer に同じ id があれば、この質問にはもう書いている。BFF を再起動しても
    // 最初の 1 回を保つため、pending の再照合より先に見る。
    if ((await readExisting(sessionPath)) === pending.id) return conflict("already_answered");

    // 書き込み直前に pending を読み直す。mypi が TUI の回答や中断で質問を終えていたら、
    // 次の質問の残骸を消さないよう、ここで止める。
    const current = await readPending(sessionPath);
    if (
      current === null ||
      current.id !== pending.id ||
      current.question !== pending.question ||
      answerOf(current, request.answers) === null
    ) {
      return conflict("question_changed");
    }

    try {
      await writeAnswer(sessionPath, pending.id, answer);
    } catch {
      return { ok: false, status: 502, error: "write_failed" };
    }
    return { ok: true };
  };

  return {
    async answer(input: AskAnswerInput): Promise<AskAnswerOutcome> {
      if (inFlight.has(input.paneId)) return conflict("in_progress");
      inFlight.add(input.paneId);
      try {
        return await run(input);
      } finally {
        inFlight.delete(input.paneId);
      }
    },
  };
}

// ask_user は 1 問 1 答。選択肢がある質問はラベル 1 つ、自由入力は text だけを受ける。
function answerOf(pending: AskPending, answers: readonly QuestionAnswer[]): AskAnswer | null {
  if (answers.length !== 1) return null;
  const answer = answers[0];
  if (answer === undefined || answer.question !== pending.question) return null;
  if ("labels" in answer) {
    if (pending.options === null || answer.labels.length !== 1) return null;
    const label = answer.labels[0];
    if (label === undefined || !pending.options.includes(label)) return null;
    return { kind: "option", label };
  }
  if (pending.options !== null) return null;
  const text = askText(answer.text);
  return text === null ? null : { kind: "text", text };
}

function conflict(error: string): AskAnswerOutcome {
  return { ok: false, status: 409, error };
}
