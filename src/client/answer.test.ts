import { expect, test } from "bun:test";
import type { ChatPendingQuestion } from "../server/chat/contract";
import {
  answerFailure,
  answersOf,
  ASK_FREE_TEXT_LABEL,
  askOptionLabels,
  askOptionLabelsForQuestions,
  askUserAnswerText,
  askUserAnswers,
  answerSummary,
  isAnswered,
  NO_CHOICE,
  nextPage,
  pickLabel,
  pickOther,
  questionLabel,
  typeOther,
  unansweredIndexes,
} from "./answer";

const single: ChatPendingQuestion = {
  question: "好きな色は？",
  header: "色",
  multiSelect: false,
  options: [
    { label: "赤", description: null },
    { label: "青", description: null },
    { label: "緑", description: null },
  ],
};
const multi: ChatPendingQuestion = { ...single, question: "使う色は？", multiSelect: true };

test("a single choice keeps exactly one label and stays selected when pressed again", () => {
  const red = pickLabel(single, NO_CHOICE, "赤");
  const blue = pickLabel(single, red, "青");

  expect(blue.labels).toEqual(["青"]);
  expect(pickLabel(single, blue, "青").labels).toEqual(["青"]);
});

test("a multiple choice toggles each label", () => {
  let choice = pickLabel(multi, NO_CHOICE, "赤");
  choice = pickLabel(multi, choice, "緑");
  expect(choice.labels).toEqual(["赤", "緑"]);

  expect(pickLabel(multi, choice, "赤").labels).toEqual(["緑"]);
});

test("a label that is not an option is ignored", () => {
  expect(pickLabel(single, NO_CHOICE, "黄")).toEqual(NO_CHOICE);
});

test("choosing free input drops the options, and choosing an option drops free input", () => {
  const other = pickOther(pickLabel(multi, NO_CHOICE, "赤"));
  expect(other).toEqual({ labels: [], other: true, text: "" });

  const typed = typeOther(other, "紫");
  const back = pickLabel(multi, typed, "青");
  expect(back).toEqual({ labels: ["青"], other: false, text: "紫" });
  // 自由入力に戻ると、書きかけの文字がそのまま残っている。
  expect(pickOther(back)).toEqual({ labels: [], other: true, text: "紫" });
});

test("pressing free input again closes it", () => {
  expect(pickOther(pickOther(NO_CHOICE)).other).toBe(false);
});

test("the answer is ready only when every question has a choice or text", () => {
  const questions = [single, multi];

  expect(answersOf(questions, [])).toBeNull();
  expect(answersOf(questions, [pickLabel(single, NO_CHOICE, "赤")])).toBeNull();
  expect(
    answersOf(questions, [pickLabel(single, NO_CHOICE, "赤"), pickLabel(multi, NO_CHOICE, "青")]),
  ).toEqual([
    { question: "好きな色は？", labels: ["赤"] },
    { question: "使う色は？", labels: ["青"] },
  ]);
});

test("labels are sent in the order of the options, not the order they were pressed", () => {
  let choice = pickLabel(multi, NO_CHOICE, "緑");
  choice = pickLabel(multi, choice, "赤");

  expect(answersOf([multi], [choice])).toEqual([{ question: "使う色は？", labels: ["赤", "緑"] }]);
});

test("free input answers with text and is not ready while blank", () => {
  const blank = pickOther(NO_CHOICE);
  expect(answersOf([single], [blank])).toBeNull();
  expect(answersOf([single], [typeOther(blank, "  \n ")])).toBeNull();

  expect(answersOf([single], [typeOther(blank, " 紫に近い青\n")])).toEqual([
    { question: "好きな色は？", text: "紫に近い青" },
  ]);
});

test("a free input row with no text does not fall back to the options that were picked before", () => {
  const picked = pickLabel(single, NO_CHOICE, "赤");

  expect(answersOf([single], [pickOther(picked)])).toBeNull();
});

test("a too long answer asks for a shorter one and any other failure sends the person to the terminal", () => {
  expect(answerFailure(413)).toBe("回答が長すぎて送れません。短くしてください。");
  for (const status of [0, 400, 409, 502]) {
    expect(answerFailure(status)).toBe("回答できませんでした。端末で答えてください。");
  }
});

test("a pi free-text answer is trimmed and keeps inner newlines and tabs", () => {
  const question = { ...single, options: [] };
  const text = typeOther({ ...NO_CHOICE, other: true }, "  1 行目\n\t2 行目  ");
  expect(askUserAnswers(question, text)).toEqual([
    { question: "好きな色は？", text: "1 行目\n\t2 行目" },
  ]);
  // trim して空になる入力は送らない。
  expect(askUserAnswers(question, typeOther(text, " \n\t "))).toBeNull();
  // 長さはコードポイントで見る。
  expect(askUserAnswers(question, typeOther(text, "😀".repeat(2_000)))).not.toBeNull();
  expect(askUserAnswers(question, typeOther(text, "😀".repeat(2_001)))).toBeNull();
});

test("model options that collide with free text and each other get unique display labels", () => {
  const options = [
    { label: ASK_FREE_TEXT_LABEL },
    { label: `${ASK_FREE_TEXT_LABEL}（選択肢）` },
    { label: "Beta" },
  ];
  expect(askOptionLabels(options, true)).toEqual([
    `${ASK_FREE_TEXT_LABEL}（選択肢）`,
    `${ASK_FREE_TEXT_LABEL}（選択肢）…`,
    "Beta",
  ]);
  expect(new Set(askOptionLabels(options, true)).size).toBe(3);
  // 自由入力行がないときは元のラベルをそのまま使う。
  expect(askOptionLabels(options, false)).toEqual([
    ASK_FREE_TEXT_LABEL,
    `${ASK_FREE_TEXT_LABEL}（選択肢）`,
    "Beta",
  ]);
  // 表示だけを変え、送るラベルは元のまま。
  const question = {
    ...single,
    options: options.map((option) => ({ ...option, description: null })),
  };
  const picked = pickLabel(question, NO_CHOICE, ASK_FREE_TEXT_LABEL);
  expect(askUserAnswers(question, picked)).toEqual([
    { question: "好きな色は？", labels: [ASK_FREE_TEXT_LABEL] },
  ]);
});

test("each question uses its own option labels", () => {
  const questions = [
    {
      options: [{ label: "クイックスタート" }, { label: "コマンド" }],
    },
    {
      options: [{ label: "範囲 A" }, { label: "範囲 B" }],
    },
  ];
  expect(askOptionLabelsForQuestions(questions, true)).toEqual([
    ["クイックスタート", "コマンド"],
    ["範囲 A", "範囲 B"],
  ]);
});

test("the optimistic answer text mirrors the pi answer", () => {
  expect(askUserAnswerText([{ question: "色", labels: ["青"] }])).toBe("青");
  expect(askUserAnswerText([{ question: "色", text: " 自由入力 " }])).toBe(" 自由入力 ");
  expect(askUserAnswerText([{ question: "色", text: " " }])).toBeNull();
  expect(
    askUserAnswerText([
      { question: "色", labels: ["青"] },
      { question: "範囲", labels: ["コマンド"] },
    ]),
  ).toBeNull();
});

test("a pi option answer is exactly one label from the question", () => {
  const picked = pickLabel(single, NO_CHOICE, "青");
  expect(askUserAnswers(single, picked)).toEqual([{ question: "好きな色は？", labels: ["青"] }]);
  expect(askUserAnswers(single, NO_CHOICE)).toBeNull();
  expect(askUserAnswers(single, { ...picked, labels: ["赤", "青"] })).toBeNull();
  expect(askUserAnswers(single, { ...picked, labels: ["黄"] })).toBeNull();
});

test("a question counts as answered by a picked option or by non-blank free text", () => {
  expect(isAnswered(single, NO_CHOICE)).toBe(false);
  expect(isAnswered(single, pickLabel(single, NO_CHOICE, "赤"))).toBe(true);
  // 自由入力の行を開いただけでは答えにならない。
  expect(isAnswered(single, pickOther(NO_CHOICE))).toBe(false);
  expect(isAnswered(single, typeOther(pickOther(NO_CHOICE), " \n "))).toBe(false);
  expect(isAnswered(single, typeOther(pickOther(NO_CHOICE), "紫"))).toBe(true);
  // 選択肢に無いラベルは答えにしない。
  expect(isAnswered(single, { labels: ["黄"], other: false, text: "" })).toBe(false);
});

test("the unanswered questions are listed by index, including the ones with no choice yet", () => {
  const third: ChatPendingQuestion = { ...single, question: "好きな数は？" };
  const questions = [single, multi, third];

  expect(unansweredIndexes(questions, [])).toEqual([0, 1, 2]);
  expect(unansweredIndexes(questions, [pickLabel(single, NO_CHOICE, "赤")])).toEqual([1, 2]);
  // 間の質問だけ空いていても、その番号が分かる。
  const choices = [
    pickLabel(single, NO_CHOICE, "赤"),
    NO_CHOICE,
    pickLabel(third, NO_CHOICE, "青"),
  ];
  expect(unansweredIndexes(questions, choices)).toEqual([1]);
});

test("the next page is the following question until everything is answered, then the review", () => {
  const questions = [single, multi, single];
  const red = pickLabel(single, NO_CHOICE, "赤");

  expect(nextPage(questions, [red], 0)).toBe(1);
  expect(nextPage(questions, [red, pickLabel(multi, NO_CHOICE, "青")], 1)).toBe(2);
  // 最後の質問で答え終えたら、確認ページ（質問数番目）。
  expect(nextPage(questions, [red, pickLabel(multi, NO_CHOICE, "青"), red], 2)).toBe(3);
  // 確認から 1 問だけ直したときは、次の質問ではなく確認へ戻る。
  expect(nextPage(questions, [red, pickLabel(multi, NO_CHOICE, "青"), red], 0)).toBe(3);
  // 直した質問が複数選択や自由入力でも同じ。
  const typed = typeOther(pickOther(NO_CHOICE), "紫");
  expect(nextPage(questions, [typed, pickLabel(multi, NO_CHOICE, "青"), red], 0)).toBe(3);
  expect(nextPage(questions, [red, pickLabel(multi, NO_CHOICE, "青"), red], 1)).toBe(3);
});

test("a question without a header is called by its number", () => {
  expect(questionLabel(single, 0)).toBe("色");
  expect(questionLabel({ ...single, header: null }, 1)).toBe("質問 2");
});

test("the review shows the options in their order, the free text, or nothing", () => {
  let choice = pickLabel(multi, NO_CHOICE, "緑");
  choice = pickLabel(multi, choice, "赤");
  expect(answerSummary(multi, choice)).toBe("赤、緑");

  expect(answerSummary(single, typeOther(pickOther(NO_CHOICE), " 紫\n"))).toBe("紫");
  expect(answerSummary(single, pickOther(NO_CHOICE))).toBeNull();
  expect(answerSummary(single, NO_CHOICE)).toBeNull();
});
