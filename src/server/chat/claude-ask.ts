import type { QuestionAnswer } from "../../shared/answer";
import { normalizeQuestionText } from "./claude-pending";
import type { ChatMessage, ChatPendingQuestion } from "./contract";

// TUI のダイアログで答えたときの `toolUseResult.answers`（質問文 → 答え）を回答の形へ読み戻す。
// 複数選択の答えは Claude Code が `, ` でつなぐ。選択肢に無い答えは「その他」の自由入力として
// 扱う。答えの無い質問が 1 つでもあれば、回答として扱わない。
export function answersFromToolResult(
  questions: readonly ChatPendingQuestion[],
  result: Readonly<Record<string, string>>,
): QuestionAnswer[] | null {
  const byQuestion = new Map<string, string>();
  for (const [key, value] of Object.entries(result)) {
    byQuestion.set(normalizeQuestionText(key), value);
  }

  const answers: QuestionAnswer[] = [];
  for (const question of questions) {
    const value = byQuestion.get(question.question);
    if (value === undefined || value.trim() === "") return null;
    const labels = chosenLabels(question, value);
    answers.push(
      labels === null
        ? { question: question.question, text: value }
        : { question: question.question, labels },
    );
  }
  return answers;
}

function chosenLabels(question: ChatPendingQuestion, value: string): string[] | null {
  const known = new Set(question.options.map((option) => option.label));
  if (known.has(value)) return [value];
  if (!question.multiSelect) return null;
  const labels = value.split(", ");
  return new Set(labels).size === labels.length && labels.every((label) => known.has(label))
    ? labels
    : null;
}

// 回答済みの質問を、質問と回答の組として会話へ合成する。複数の質問は 1 問ごとに質問と回答を
// 並べる。合成した行は会話の実体ではないので、編集の対象にしない。
export function askMessages(exchange: {
  toolUseId: string;
  questions: readonly ChatPendingQuestion[];
  answers: readonly QuestionAnswer[];
  questionAt: number;
  answerAt: number;
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const [index, question] of exchange.questions.entries()) {
    const answer = exchange.answers.find((candidate) => candidate.question === question.question);
    if (answer === undefined) continue;
    const chosen = "labels" in answer ? new Set(answer.labels) : new Set<string>();
    const key = `ask:${exchange.toolUseId}:${index}`;
    messages.push(
      {
        id: `${key}:question`,
        role: "agent",
        text: question.question,
        at: exchange.questionAt,
        synthetic: true,
        askOptions: question.options.map((option) => ({
          label: option.label,
          // Claude の選択肢に推奨の欄は無い。推奨はラベルに書かれる（`(Recommended)`）。
          recommended: false,
          selected: chosen.has(option.label),
        })),
      },
      {
        id: `${key}:answer`,
        role: "user",
        text: "labels" in answer ? answer.labels.join(", ") : answer.text,
        at: exchange.answerAt,
        synthetic: true,
        answerKind: "labels" in answer ? "option" : "text",
      },
    );
  }
  return messages;
}
