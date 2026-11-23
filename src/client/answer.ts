import type { ChatPendingQuestion } from "../server/chat/contract";
import type { QuestionAnswer } from "../shared/answer";
import { ASK_TEXT_MAX } from "../shared/ask-user";
import { flatText } from "../shared/flat-text";

// 質問 1 問ぶんの選択状態。選択肢と自由入力は同時に答えにならない（契約は labels か text の
// どちらか一方）ので、自由入力を選ぶと選択肢は外れ、選択肢を選ぶと自由入力は外れる。
export type Choice = { labels: readonly string[]; other: boolean; text: string };

export const NO_CHOICE: Choice = { labels: [], other: false, text: "" };

// 単一選択は選んだ 1 つに置き換え、もう一度押しても外さない（答えは必ず 1 つ要る）。
// 複数選択は押すたびに入れ外しする。
export function pickLabel(question: ChatPendingQuestion, choice: Choice, label: string): Choice {
  if (!question.options.some((option) => option.label === label)) return choice;
  if (!question.multiSelect) return { labels: [label], other: false, text: choice.text };
  const labels = choice.labels.includes(label)
    ? choice.labels.filter((value) => value !== label)
    : [...choice.labels, label];
  return { labels, other: false, text: choice.text };
}

// 自由入力の行を押す。選んでいた選択肢は外す。もう一度押すと閉じる。
export function pickOther(choice: Choice): Choice {
  return choice.other
    ? { ...choice, other: false }
    : { labels: [], other: true, text: choice.text };
}

export function typeOther(choice: Choice, text: string): Choice {
  return { ...choice, text };
}

// 全質問に答えが揃ったときだけ回答の本体を返す。送れない間は「この内容で答える」を無効にする。
// 選択肢は選択肢の並び順で返し、入れた順に依存させない。
export function answersOf(
  questions: readonly ChatPendingQuestion[],
  choices: readonly Choice[],
): QuestionAnswer[] | null {
  const answers: QuestionAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const choice = choices[index] ?? NO_CHOICE;
    if (choice.other) {
      const text = flatText(choice.text);
      if (text === "") return null;
      answers.push({ question: question.question, text });
      continue;
    }
    const labels = question.options
      .map((option) => option.label)
      .filter((label) => choice.labels.includes(label));
    if (labels.length === 0) return null;
    answers.push({ question: question.question, labels });
  }
  return answers;
}

// 自由入力の行は常にこのラベルにする。モデルの選択肢が同じラベルでも、表示だけを
// 変えて回答は元のラベルで送る（重複したボタンを作らない）。
export const ASK_FREE_TEXT_LABEL = "その他（自由入力）";

export function askOptionLabels(
  options: readonly { label: string }[],
  freeText: boolean,
): string[] {
  const reserved = freeText ? ASK_FREE_TEXT_LABEL : null;
  const used = new Set<string>();
  return options.map((option) => {
    let label = option.label;
    if (reserved !== null && label === reserved) label = `${label}（選択肢）`;
    while (used.has(label) || label === reserved) label = `${label}…`;
    used.add(label);
    return label;
  });
}

// pi の ask_user の回答。Claude の flatText と違い、trim と長さだけを見て、内部の改行・タブを
// 保つ（docs/adr/pi-integration.md）。選択肢は 1 つだけ。自由入力は選択肢があっても使える。
// 制御文字は BFF が 400 で拒否する。
export function askUserAnswers(
  question: ChatPendingQuestion,
  choice: Choice,
): QuestionAnswer[] | null {
  if (choice.other) {
    const text = choice.text.trim();
    const length = Array.from(text).length;
    if (length === 0 || length > ASK_TEXT_MAX) return null;
    return [{ question: question.question, text }];
  }
  if (choice.labels.length !== 1) return null;
  const label = choice.labels[0];
  if (label === undefined) return null;
  if (!question.options.some((option) => option.label === label)) return null;
  return [{ question: question.question, labels: [label] }];
}

// status は BFF の応答。0 はネットワークの失敗と打ち切り。
export function answerFailure(status: number): string {
  if (status === 413) return "回答が長すぎて送れません。短くしてください。";
  return "回答できませんでした。端末で答えてください。";
}
