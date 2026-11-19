import { expect, test } from "bun:test";
import { type AnswerQuestion, composeAnswer, parseAnswerRequest } from "./answer";

const color: AnswerQuestion = {
  question: "好きな色は？",
  multiSelect: false,
  options: [{ label: "赤" }, { label: "青" }],
};
const fruits: AnswerQuestion = {
  question: "どれを使いますか？",
  multiSelect: true,
  options: [{ label: "りんご" }, { label: "なし" }, { label: "もも" }],
};

test("each question becomes one line of the question and what was chosen", () => {
  const text = composeAnswer(
    [color, fruits],
    [
      { question: "好きな色は？", labels: ["青"] },
      { question: "どれを使いますか？", labels: ["りんご", "もも"] },
    ],
  );

  expect(text).toBe("好きな色は？: 青\nどれを使いますか？: りんご, もも");
});

test("the lines follow the questions, not the order the client sent", () => {
  const text = composeAnswer(
    [color, fruits],
    [
      { question: "どれを使いますか？", labels: ["なし"] },
      { question: "好きな色は？", labels: ["赤"] },
    ],
  );

  expect(text).toBe("好きな色は？: 赤\nどれを使いますか？: なし");
});

test("free text answers in place of the options and is flattened to one line", () => {
  const text = composeAnswer(
    [color],
    [{ question: "好きな色は？", text: "  緑に近い\n青\u0007です  " }],
  );

  expect(text).toBe("好きな色は？: 緑に近い 青です");
});

test("a label that holds a separator is quoted so the choices stay countable", () => {
  const text = composeAnswer(
    [
      {
        question: "どの形式？",
        multiSelect: true,
        options: [
          { label: "JSON, 整形あり" },
          { label: "key: value" },
          { label: '"生"' },
          { label: "CSV" },
        ],
      },
    ],
    [{ question: "どの形式？", labels: ["JSON, 整形あり", "key: value", '"生"', "CSV"] }],
  );

  expect(text).toBe('どの形式？: "JSON, 整形あり", "key: value", "\\"生\\"", CSV');
});

test.each([
  ["no answer", []],
  ["a question that was never asked", [{ question: "別の質問", labels: ["赤"] }]],
  [
    "the same question twice",
    [
      { question: "好きな色は？", labels: ["赤"] },
      { question: "好きな色は？", labels: ["青"] },
    ],
  ],
  ["an empty choice", [{ question: "好きな色は？", labels: [] }]],
  ["a label that is not an option", [{ question: "好きな色は？", labels: ["緑"] }]],
  ["two labels for a single choice", [{ question: "好きな色は？", labels: ["赤", "青"] }]],
  ["the same label twice", [{ question: "好きな色は？", labels: ["赤", "赤"] }]],
  ["free text with only blanks", [{ question: "好きな色は？", text: " \n\t " }]],
  ["free text with only control characters", [{ question: "好きな色は？", text: "\u0000\u0007" }]],
])("an answer with %s is refused", (_name, answers) => {
  expect(composeAnswer([color], answers)).toBeNull();
});

test("an answer that leaves a question unanswered is refused", () => {
  expect(composeAnswer([color, fruits], [{ question: "好きな色は？", labels: ["赤"] }])).toBeNull();
});

test("multiple labels are accepted only for a multi-select question", () => {
  expect(
    composeAnswer([fruits], [{ question: "どれを使いますか？", labels: ["りんご", "なし"] }]),
  ).toBe("どれを使いますか？: りんご, なし");
});

test("a request carries a tool use id and one of labels or text per answer", () => {
  expect(
    parseAnswerRequest({
      toolUseId: "toolu_1",
      answers: [
        { question: "Q1", labels: ["A"] },
        { question: "Q2", text: "free" },
      ],
    }),
  ).toEqual({
    toolUseId: "toolu_1",
    answers: [
      { question: "Q1", labels: ["A"] },
      { question: "Q2", text: "free" },
    ],
  });
});

test.each([
  ["not an object", "text"],
  ["no tool use id", { answers: [{ question: "Q", labels: ["A"] }] }],
  ["an empty tool use id", { toolUseId: "", answers: [{ question: "Q", labels: ["A"] }] }],
  ["no answers", { toolUseId: "t", answers: [] }],
  [
    "too many answers",
    { toolUseId: "t", answers: Array(5).fill({ question: "Q", labels: ["A"] }) },
  ],
  [
    "labels and text together",
    { toolUseId: "t", answers: [{ question: "Q", labels: ["A"], text: "x" }] },
  ],
  ["neither labels nor text", { toolUseId: "t", answers: [{ question: "Q" }] }],
  ["labels that are not strings", { toolUseId: "t", answers: [{ question: "Q", labels: [1] }] }],
  [
    "too many labels",
    { toolUseId: "t", answers: [{ question: "Q", labels: Array(11).fill("A") }] },
  ],
  ["text that is not a string", { toolUseId: "t", answers: [{ question: "Q", text: 1 }] }],
  [
    "a question that is not a string",
    { toolUseId: "t", answers: [{ question: 1, labels: ["A"] }] },
  ],
])("a request with %s is refused", (_name, body) => {
  expect(parseAnswerRequest(body)).toBeNull();
});
