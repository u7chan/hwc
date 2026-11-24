import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppState } from "./herdr/state";
import { type FakeStore, chatState, createFakeStore, createTestApp } from "./app.test-helpers";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function blockedState(blocked = true): AppState {
  return {
    ...chatState,
    workspaces: chatState.workspaces.map((workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) => ({
          ...pane,
          agentStatus: blocked ? ("blocked" as const) : ("idle" as const),
        })),
      })),
    })),
  };
}

async function fixture(options: { blocked?: boolean; source?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hwc-answer-ask-"));
  directories.push(dir);
  const path = join(dir, "session.jsonl");
  const store: FakeStore = createFakeStore(blockedState(options.blocked));
  if (options.source !== false) store.setChatSource("w1:p1", { agent: "pi", path });

  const sent: string[] = [];
  const { app } = createTestApp({
    store,
    panes: {
      send: async ({ text }) => {
        sent.push(`send:${text}`);
      },
      sendKeys: async ({ keys }) => {
        sent.push(`keys:${keys.join("+")}`);
      },
    },
  });

  const writePending = (
    id = ID,
    options2: string[] | null = ["赤", "青"],
    question = "どれにしますか？",
    freeText = true,
  ) =>
    writeFile(
      `${path}.ask.json`,
      JSON.stringify({ v: 1, id, question, options: options2, freeText }),
    );
  const post = (payload: unknown) =>
    app.request("/api/panes/w1:p1/answer-question", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const optionBody = (labels = ["青"], question = "どれにしますか？") => ({
    toolUseId: ID,
    answers: [{ question, labels }],
  });
  const textBody = (text = "自由入力です", question = "自由に書いてください") => ({
    toolUseId: ID,
    answers: [{ question, text }],
  });
  return { path, post, writePending, optionBody, textBody, sent };
}

test("an option answer writes the answer file and sends no keys or text", async () => {
  const f = await fixture();
  await f.writePending();

  const response = await f.post(f.optionBody());

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(await readFile(`${f.path}.ask.answer.json`, "utf8")).toBe(
    `${JSON.stringify({ v: 1, id: ID, answer: { kind: "option", label: "青" } })}\n`,
  );
  expect(f.sent).toEqual([]);
});

test("a free-text answer keeps newlines and tabs in the answer file", async () => {
  const f = await fixture();
  await f.writePending(ID, null, "自由に書いてください");

  const response = await f.post(f.textBody("  1 行目\n\t2 行目  "));

  expect(response.status).toBe(200);
  expect(await readFile(`${f.path}.ask.answer.json`, "utf8")).toBe(
    `${JSON.stringify({
      v: 1,
      id: ID,
      answer: { kind: "text", text: "1 行目\n\t2 行目" },
    })}\n`,
  );
  expect(f.sent).toEqual([]);
});

test("a pane that is not blocked is a conflict and writes nothing", async () => {
  const f = await fixture({ blocked: false });
  await f.writePending();

  const response = await f.post(f.optionBody());

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_waiting" });
  expect(await readFile(`${f.path}.ask.answer.json`, "utf8").catch(() => null)).toBeNull();
});

test("a pane without a session source is a conflict", async () => {
  const f = await fixture({ source: false });
  await f.writePending();

  expect((await f.post(f.optionBody())).status).toBe(409);
});

test("a missing pending or another id is a conflict", async () => {
  const f = await fixture();
  expect((await f.post(f.optionBody())).status).toBe(409);

  await f.writePending(OTHER);
  const response = await f.post(f.optionBody());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_waiting" });
});

test("a question that does not match the pending one is a bad request", async () => {
  const f = await fixture();
  await f.writePending();

  const response = await f.post(f.optionBody(["青"], "別の質問"));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_answer" });
});

test.each([
  ["a label outside the options", ["緑"]],
  ["two labels", ["赤", "青"]],
  ["no label", []],
])("an option answer with %s is a bad request", async (_name, labels) => {
  const f = await fixture();
  await f.writePending();

  expect((await f.post(f.optionBody(labels))).status).toBe(400);
  expect(await readFile(`${f.path}.ask.answer.json`, "utf8").catch(() => null)).toBeNull();
});

test("text on an options question and labels on a free-text question are bad requests", async () => {
  const f = await fixture();
  await f.writePending(ID, ["赤", "青"], "どれにしますか？", false);
  expect((await f.post(f.textBody("青", "どれにしますか？"))).status).toBe(400);

  await f.writePending(ID, null, "自由に書いてください");
  expect((await f.post(f.optionBody())).status).toBe(400);
});

test("the same question cannot be answered twice", async () => {
  const f = await fixture();
  await f.writePending();

  expect((await f.post(f.optionBody())).status).toBe(200);
  const retry = await f.post(f.optionBody());

  expect(retry.status).toBe(409);
  expect(await retry.json()).toEqual({ error: "already_answered" });
  // 最初に書いた内容をそのまま残す。
  expect(await readFile(`${f.path}.ask.answer.json`, "utf8")).toContain('"label":"青"');
});

test("a broken answer for the same id is treated as absent and overwritten", async () => {
  const f = await fixture();
  await f.writePending();
  await writeFile(
    `${f.path}.ask.answer.json`,
    `${JSON.stringify({ v: 1, id: ID, answer: "broken" })}\n`,
  );

  expect((await f.post(f.optionBody())).status).toBe(200);
  expect(await readFile(`${f.path}.ask.answer.json`, "utf8")).toContain('"label":"青"');
});

test("an answer left by another question is replaced", async () => {
  const f = await fixture();
  await f.writePending();
  await writeFile(
    `${f.path}.ask.answer.json`,
    `${JSON.stringify({ v: 1, id: OTHER, answer: { kind: "option", label: "赤" } })}\n`,
  );

  expect((await f.post(f.optionBody())).status).toBe(200);
  expect(await readFile(`${f.path}.ask.answer.json`, "utf8")).toContain('"id":"' + ID + '"');
});

test("a write failure is a 502 and the pending ask remains", async () => {
  const f = await fixture();
  await f.writePending();
  // answer のパスをディレクトリにすると rename が失敗する。
  await mkdir(`${f.path}.ask.answer.json`);

  const response = await f.post(f.optionBody());

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "write_failed" });
  expect(await readFile(`${f.path}.ask.json`, "utf8")).toContain(ID);
  expect(f.sent).toEqual([]);
});
