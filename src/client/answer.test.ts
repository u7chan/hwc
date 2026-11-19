import { expect, test } from "bun:test";
import type { ChatPendingQuestion } from "../server/chat/contract";
import { answerFailure, answersOf, NO_CHOICE, pickLabel, pickOther, typeOther } from "./answer";

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
