import { flatText } from "./flat-text";
import { asRecord } from "./json";

// AskUserQuestion への回答。質問ごとに、選択肢のラベルか自由入力のどちらか一方だけを持つ。
// クライアントが組み立てて送り、BFF が pending の質問と照合してから本文にする（docs/adr/claude-integration.md）。
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

// 質問は 4 件、選択肢は 10 件まで（docs/adr/claude-integration.md）。これを超える body は形の時点で弾く。
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

// composeAnswer の逆。履歴に残った回答の本文から、質問ごとの答えを読み戻す。形が合わない本文
// （行数や質問文が違う）は回答として扱わない。自由入力の本文が選択肢と同じラベルだったときは、
// 選択肢の回答と区別できないので選択肢として読む。
export function parseAnswerText(
  questions: readonly AnswerQuestion[],
  text: string,
): QuestionAnswer[] | null {
  const lines = text.split("\n");
  if (lines[0] !== ANSWER_HEADING || lines.length !== questions.length + 1) return null;

  const answers: QuestionAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const prefix = `${question.question}: `;
    const line = lines[index + 1];
    if (line === undefined || !line.startsWith(prefix)) return null;
    const body = line.slice(prefix.length);
    if (body === "") return null;
    const labels = chosenLabelsOf(question, body);
    answers.push(
      labels === null
        ? { question: question.question, text: body }
        : { question: question.question, labels },
    );
  }
  return answers;
}

// quoteLabel で引用した区切りを、引用ごと 1 つの項目として読む。選択肢に無い項目が 1 つでも
// あれば、選んだ内容ではなく自由入力として扱う。
function chosenLabelsOf(question: AnswerQuestion, body: string): string[] | null {
  const labels = splitLabels(body);
  if (labels === null || labels.length === 0) return null;
  if (!question.multiSelect && labels.length !== 1) return null;
  if (new Set(labels).size !== labels.length) return null;
  const known = new Set(question.options.map((option) => option.label));
  return labels.every((label) => known.has(label)) ? labels : null;
}

function splitLabels(body: string): string[] | null {
  const labels: string[] = [];
  let at = 0;
  for (;;) {
    if (body[at] === '"') {
      const end = quotedEnd(body, at);
      if (end === null) return null;
      try {
        const label: unknown = JSON.parse(body.slice(at, end));
        if (typeof label !== "string") return null;
        labels.push(label);
      } catch {
        return null;
      }
      at = end;
      if (at === body.length) return labels;
      if (!body.startsWith(", ", at)) return null;
      at += 2;
      continue;
    }
    const next = body.indexOf(", ", at);
    labels.push(body.slice(at, next < 0 ? body.length : next));
    if (next < 0) return labels;
    at = next + 2;
  }
}

// `"` で始まる JSON 文字列の終わり（閉じの `"` の次の位置）。
function quotedEnd(body: string, start: number): number | null {
  for (let index = start + 1; index < body.length; index += 1) {
    if (body[index] === "\\") {
      index += 1;
      continue;
    }
    if (body[index] === '"') return index + 1;
  }
  return null;
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
