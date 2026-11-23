import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askAnswerPath,
  askPendingPath,
  askQuestion,
  askText,
  parseAskAnswer,
  parseAskPending,
  readAnswerId,
  readAsk,
  writeAskAnswer,
} from "./pi-ask";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hwc-ask-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sessionPath = (): string => join(dir, "session.jsonl");
const pending = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  id: ID,
  question: "どれにしますか？",
  options: ["赤", "青"],
  ...overrides,
});
const answer = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  id: ID,
  answer: { kind: "option", label: "青" },
  ...overrides,
});

test("a pending ask is accepted with its options", () => {
  expect(parseAskPending(pending())).toEqual({
    id: ID,
    question: "どれにしますか？",
    options: ["赤", "青"],
  });
});

test("a pending ask for free text keeps options as null", () => {
  expect(parseAskPending(pending({ options: null }))).toEqual({
    id: ID,
    question: "どれにしますか？",
    options: null,
  });
});

test("the question normalizes line endings and trims, but keeps newlines", () => {
  const parsed = parseAskPending(pending({ question: "  1 行目\r\n2 行目\r3 行目  " }));
  expect(parsed?.question).toBe("1 行目\n2 行目\n3 行目");
  expect(parseAskPending(pending({ question: "見出し\n本文" }))?.question).toBe("見出し\n本文");
});

test("the question is limited by code points, not UTF-16 units", () => {
  expect(askQuestion("😀".repeat(500))).toBe("😀".repeat(500));
  expect(askQuestion("😀".repeat(501))).toBeNull();
  expect(askQuestion("   ")).toBeNull();
  expect(askQuestion("a\u0000b")).toBeNull();
  expect(askQuestion("a\rb")).toBe("a\nb");
});

test.each([
  ["without options", pending({ options: undefined })],
  ["with an unknown version", pending({ v: 2 })],
  ["without v", pending({ v: undefined })],
  ["with a non-uuid id", pending({ id: "ask-1" })],
  ["with an empty question", pending({ question: "" })],
  ["with a control character", pending({ question: "a\u0007b" })],
  ["with one option", pending({ options: ["赤"] })],
  ["with seven options", pending({ options: ["a", "b", "c", "d", "e", "f", "g"] })],
  ["with an empty option", pending({ options: ["赤", "  "] })],
  ["with duplicate options after trim", pending({ options: ["赤", " 赤 "] })],
  ["with a long option", pending({ options: ["赤", "あ".repeat(121)] })],
  ["with a newline in an option", pending({ options: ["赤", "青\n緑"] })],
  ["with a non-string option", pending({ options: ["赤", 1] })],
  ["with extra fields only", { v: 1, id: ID }],
])("a pending ask %s is discarded", (_name, value) => {
  expect(parseAskPending(value)).toBeNull();
});

test("options are trimmed before the duplicate check", () => {
  expect(parseAskPending(pending({ options: [" 赤 ", "青"] }))).toEqual({
    id: ID,
    question: "どれにしますか？",
    options: ["赤", "青"],
  });
});

test("an option answer must be one of the pending labels", () => {
  const ask = parseAskPending(pending());
  if (ask === null) throw new Error("fixture is broken");
  expect(parseAskAnswer(answer(), ask)).toEqual({ kind: "option", label: "青" });
  // 前後の空白を付けたラベルは一致しない。
  expect(parseAskAnswer(answer({ answer: { kind: "option", label: " 青" } }), ask)).toBeNull();
  expect(parseAskAnswer(answer({ answer: { kind: "option", label: "緑" } }), ask)).toBeNull();
  expect(parseAskAnswer(answer({ answer: { kind: "text", text: "青" } }), ask)).toBeNull();
});

test("a text answer is accepted only for a free-text question", () => {
  const ask = parseAskPending(pending({ options: null }));
  if (ask === null) throw new Error("fixture is broken");
  expect(
    parseAskAnswer(answer({ answer: { kind: "text", text: "  1 行目\n\t2 行目  " } }), ask),
  ).toEqual({ kind: "text", text: "1 行目\n\t2 行目" });
  expect(parseAskAnswer(answer(), ask)).toBeNull();
});
test("the text answer is limited and rejects controls other than newline and tab", () => {
  expect(askText("😀".repeat(2_000))).toBe("😀".repeat(2_000));
  expect(askText("😀".repeat(2_001))).toBeNull();
  expect(askText("a\nb\tc")).toBe("a\nb\tc");
  expect(askText("a\rb")).toBeNull();
  expect(askText("a\u0000b")).toBeNull();
  expect(askText("   ")).toBeNull();
});

test.each([
  ["with another id", answer({ id: OTHER })],
  ["with an unknown version", answer({ v: 2 })],
  ["without an answer", answer({ answer: null })],
  ["with an unknown answer kind", answer({ answer: { kind: "number", value: 1 } })],
  ["with the label as text", answer({ answer: { kind: "text", label: "青" } })],
])("an answer %s is discarded", (_name, value) => {
  const ask = parseAskPending(pending({ options: null }));
  if (ask === null) throw new Error("fixture is broken");
  expect(parseAskAnswer(value, ask)).toBeNull();
});

test("a missing, broken, or oversized pending ask is read as absent", async () => {
  expect(await readAsk(sessionPath())).toBeNull();

  await writeFile(askPendingPath(sessionPath()), "{");
  expect(await readAsk(sessionPath())).toBeNull();

  await writeFile(askPendingPath(sessionPath()), JSON.stringify(pending()));
  expect(await readAsk(sessionPath())).toEqual({
    id: ID,
    question: "どれにしますか？",
    options: ["赤", "青"],
  });

  // 8KB を超えるファイルは JSON を parse する前に捨てる。
  await writeFile(askPendingPath(sessionPath()), "x".repeat(8 * 1024 + 1));
  expect(await readAsk(sessionPath())).toBeNull();
});

test("an answer id is read without trusting the rest of the body", async () => {
  expect(await readAnswerId(sessionPath())).toBeNull();

  await writeFile(askAnswerPath(sessionPath()), JSON.stringify(answer()));
  expect(await readAnswerId(sessionPath())).toBe(ID);

  // 本体が壊れていても、id が読めれば書き込み前の照合に使える。
  await writeFile(askAnswerPath(sessionPath()), JSON.stringify({ v: 1, id: ID, answer: "broken" }));
  expect(await readAnswerId(sessionPath())).toBe(ID);

  await writeFile(askAnswerPath(sessionPath()), JSON.stringify({ v: 2, id: ID }));
  expect(await readAnswerId(sessionPath())).toBeNull();

  await writeFile(askAnswerPath(sessionPath()), JSON.stringify(answer({ id: "not-a-uuid" })));
  expect(await readAnswerId(sessionPath())).toBeNull();

  await writeFile(askAnswerPath(sessionPath()), "x".repeat(16 * 1024 + 1));
  expect(await readAnswerId(sessionPath())).toBeNull();
});

test("an answer is written as one JSON line with mode 0600 and replaces the old one", async () => {
  await writeAskAnswer(sessionPath(), ID, { kind: "option", label: "青" });

  const path = askAnswerPath(sessionPath());
  expect(await readFile(path, "utf8")).toBe(
    `${JSON.stringify({ v: 1, id: ID, answer: { kind: "option", label: "青" } })}\n`,
  );
  expect((await stat(path)).mode & 0o777).toBe(0o600);

  await writeAskAnswer(sessionPath(), OTHER, { kind: "text", text: "1 行目\n2 行目" });
  expect(await readAnswerId(sessionPath())).toBe(OTHER);
  expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("a failed write leaves no temporary file behind", async () => {
  // answer のパスをディレクトリにすると rename が失敗する。
  await mkdir(askAnswerPath(sessionPath()));

  await expect(
    writeAskAnswer(sessionPath(), ID, { kind: "option", label: "青" }),
  ).rejects.toThrow();
  expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
