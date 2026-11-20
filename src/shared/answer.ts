import { flatText } from "./flat-text";

// AskUserQuestion への回答。質問ごとに、選択肢のラベルか自由入力のどちらか一方だけを持つ。
// クライアントが組み立てて送り、BFF が pending の質問と照合してから本文にする（ADR 0099）。
export type QuestionAnswer =
  | { question: string; labels: string[] }
  | { question: string; text: string };

export type AnswerRequest = { toolUseId: string; answers: QuestionAnswer[] };

// 照合に使う質問の形。ChatPendingQuestion の部分集合で、shared が server の型に依存しない。
export type AnswerQuestion = {
  question: string;
  multiSelect: boolean;
  options: readonly { label: string }[];
};

// 質問は 4 件、選択肢は 10 件まで（ADR 0112）。これを超える body は形の時点で弾く。
const MAX_ANSWERS = 4;
const MAX_LABELS = 10;

// 本文の先頭の文字は、そのまま CLI の入力欄に届く。質問文が `/`（スラッシュコマンド）や
// `!`（シェル）、`#` で始まると、回答が届かないか、コマンドとして実行される。質問文で始めず、
// 固定の 1 行を先頭に置く。条件付きで足すと、どの文字が危ないかを hwc が知っている前提になる。
export const ANSWER_HEADING = "質問への回答:";

// 形の検査だけ。pending との照合は composeAnswer が行う。
export function parseAnswerRequest(body: unknown): AnswerRequest | null {
  const record = asRecord(body);
  if (record === null) return null;
  const { toolUseId, answers } = record;
  if (typeof toolUseId !== "string" || toolUseId === "") return null;
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > MAX_ANSWERS) return null;

  const parsed: QuestionAnswer[] = [];
  for (const value of answers) {
    const answer = asRecord(value);
    if (answer === null || typeof answer.question !== "string") return null;
    const hasLabels = "labels" in answer;
    const hasText = "text" in answer;
    // 両方同時には受け付けない。どちらを採るかをこちらで決めない。
    if (hasLabels === hasText) return null;
    if (hasText) {
      if (typeof answer.text !== "string") return null;
      parsed.push({ question: answer.question, text: answer.text });
      continue;
    }
    const { labels } = answer;
    if (!Array.isArray(labels) || labels.length > MAX_LABELS) return null;
    if (!labels.every((label): label is string => typeof label === "string")) return null;
    parsed.push({ question: answer.question, labels });
  }
  return { toolUseId, answers: parsed };
}

// 質問ごとの回答を、通常のユーザー発言として送る本文にする（先頭の 1 行と、質問ごとの 1 行）。
// 質問文は pending のものを使い、
// クライアントが送った文言は使わない。回答が全質問を覆っていない・選択肢に無いラベル・
// 単一選択に複数・空の回答は null。
export function composeAnswer(
  questions: readonly AnswerQuestion[],
  answers: readonly QuestionAnswer[],
): string | null {
  if (answers.length !== questions.length) return null;

  const lines: string[] = [];
  for (const question of questions) {
    const matches = answers.filter((answer) => answer.question === question.question);
    const answer = matches[0];
    if (matches.length !== 1 || answer === undefined) return null;

    const body = "text" in answer ? freeText(answer.text) : chosenLabels(question, answer.labels);
    if (body === null) return null;
    lines.push(`${question.question}: ${body}`);
  }
  return [ANSWER_HEADING, ...lines].join("\n");
}

function freeText(text: string): string | null {
  const flat = flatText(text);
  return flat === "" ? null : flat;
}

function chosenLabels(question: AnswerQuestion, labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (!question.multiSelect && labels.length !== 1) return null;
  if (new Set(labels).size !== labels.length) return null;
  const known = new Set(question.options.map((option) => option.label));
  if (!labels.every((label) => known.has(label))) return null;
  return labels.map(quoteLabel).join(", ");
}

// ラベルに区切り（`, ` と `: `）や引用符が入っていても、選んだ数と境界が読み違えられない
// ようにする。要らないラベルは、そのまま出す。
function quoteLabel(label: string): string {
  return /[,:"]/.test(label) ? JSON.stringify(label) : label;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
