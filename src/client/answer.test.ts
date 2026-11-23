import { expect, test } from "bun:test";
import type { ChatPendingQuestion } from "../server/chat/contract";
import {
  answerFailure,
  answersOf,
  ASK_FREE_TEXT_LABEL,
  askOptionLabel,
  askUserAnswers,
  NO_CHOICE,
  pickLabel,
  pickOther,
  typeOther,
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

test("a model option named like free text gets a distinct display label", () => {
  expect(askOptionLabel(ASK_FREE_TEXT_LABEL, true)).toBe(`${ASK_FREE_TEXT_LABEL}（選択肢）`);
  expect(askOptionLabel(ASK_FREE_TEXT_LABEL, false)).toBe(ASK_FREE_TEXT_LABEL);
  expect(askOptionLabel("赤", true)).toBe("赤");
  // 表示だけを変え、送るラベルは元のまま。
  const question = {
    ...single,
    options: [{ label: ASK_FREE_TEXT_LABEL, description: null }],
  };
  const picked = pickLabel(question, NO_CHOICE, ASK_FREE_TEXT_LABEL);
  expect(askUserAnswers(question, picked)).toEqual([
    { question: "好きな色は？", labels: [ASK_FREE_TEXT_LABEL] },
  ]);
});

test("a pi option answer is exactly one label from the question", () => {
  const picked = pickLabel(single, NO_CHOICE, "青");
  expect(askUserAnswers(single, picked)).toEqual([{ question: "好きな色は？", labels: ["青"] }]);
  expect(askUserAnswers(single, NO_CHOICE)).toBeNull();
  expect(askUserAnswers(single, { ...picked, labels: ["赤", "青"] })).toBeNull();
  expect(askUserAnswers(single, { ...picked, labels: ["黄"] })).toBeNull();
});
