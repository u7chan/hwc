import { expect, test } from "bun:test";
import type { ChatPending, ChatSnapshot } from "./chat/contract";
import type { AppState, PaneState } from "./herdr/state";
import { createFakeStore, createTestApp, emptyChat, pane, state } from "./app.test-helpers";

const ASK: ChatPending = {
  kind: "question",
  toolUseId: "toolu_1",
  tool: "AskUserQuestion",
  questions: [
    {
      question: "好きな色は？",
      header: "色",
      multiSelect: false,
      options: [
        { label: "赤", description: null },
        { label: "青", description: null },
      ],
    },
  ],
};

const body = { toolUseId: "toolu_1", answers: [{ question: "好きな色は？", labels: ["青"] }] };

function claudePane(overrides: Partial<PaneState> = {}): PaneState {
  return { ...pane, agent: "claude", agentStatus: "blocked", chat: true, ...overrides };
}

function stateWith(target: PaneState): AppState {
  return {
    ...state,
    workspaces: [
      {
        ...state.workspaces[0]!,
        tabs: [{ ...state.workspaces[0]!.tabs[0]!, panes: [target] }],
      },
    ],
  };
}

function fixture(
  options: { pane?: PaneState; source?: boolean; claude?: boolean; pending?: ChatPending[] } = {},
) {
  const target = options.pane ?? claudePane();
  const store = createFakeStore(stateWith(target));
  if (options.source !== false && target.agent !== null) {
    store.setChatSource(target.id, {
      agent: target.agent === "claude" ? "claude" : "pi",
      ...(target.agent === "claude" ? { sessionId: "session-1" } : { path: "/tmp/s.jsonl" }),
    } as never);
  }
  const calls: string[] = [];
  let reads = 0;
  const script = options.pending ?? [ASK];
  const claude =
    options.claude === false
      ? undefined
      : {
          snapshot: async (): Promise<ChatSnapshot> => {
            // 最初の 2 回は質問を待っている。Esc のあと tool_result が現れて消える。
            const pending = reads < script.length + 1 ? script[reads] : undefined;
            reads += 1;
            return { ...emptyChat, ...(pending === undefined ? {} : { pending }) };
          },
        };
  const { app } = createTestApp({
    store,
    claude,
    panes: {
      sendKeys: async ({ keys }) => {
        calls.push(`keys:${keys.join("+")}`);
      },
      send: async ({ text, submit }) => {
        calls.push(`send:${submit}:${text}`);
      },
    },
  });
  const post = (payload: unknown, id = target.id) =>
    app.request(`/api/panes/${id}/answer-question`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  return { post, calls };
}

test("a blocked Claude pane is answered by closing the dialog and then sending the choice", async () => {
  const { post, calls } = fixture();

  const response = await post(body);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(calls).toEqual(["keys:esc", "send:true:質問への回答:\n好きな色は？: 青"]);
});

test.each([
  ["not an object", "text"],
  ["without answers", { toolUseId: "toolu_1" }],
  [
    "with labels and text together",
    { toolUseId: "toolu_1", answers: [{ question: "Q", labels: ["A"], text: "B" }] },
  ],
])("a body %s is a bad request and touches nothing", async (_name, payload) => {
  const { post, calls } = fixture();

  expect((await post(payload)).status).toBe(400);
  expect(calls).toEqual([]);
});

test("an unknown pane is 404", async () => {
  const { post } = fixture();

  expect((await post(body, "w9:p9")).status).toBe(404);
});

test.each(["pi", "codex", "opencode"] as const)("a %s pane is refused as 400", async (agent) => {
  const { post, calls } = fixture({ pane: claudePane({ agent }) });

  const response = await post(body);

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "not_claude" });
  expect(calls).toEqual([]);
});

test.each([
  ["Herdr does not report blocked", { pane: claudePane({ agentStatus: "idle" }) }],
  ["the pane has no conversation source", { source: false }],
  ["the conversation cannot be read at all", { claude: false }],
])("it is a 409 when %s", async (_name, options) => {
  const { post, calls } = fixture(options);

  const response = await post(body);

  expect(response.status).toBe(409);
  expect(calls).toEqual([]);
});

test("a question that is no longer the pending one is a 409 and sends nothing", async () => {
  const { post, calls } = fixture({ pending: [{ ...ASK, toolUseId: "toolu_other" }] });

  expect((await post(body)).status).toBe(409);
  expect(calls).toEqual([]);
});

test("an answer that does not fit the question is a 400 and the dialog stays open", async () => {
  const { post, calls } = fixture();

  const response = await post({
    toolUseId: "toolu_1",
    answers: [{ question: "好きな色は？", labels: ["緑"] }],
  });

  expect(response.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a body over the input limit is a 413", async () => {
  const { post, calls } = fixture();

  const response = await post({
    toolUseId: "toolu_1",
    answers: [{ question: "好きな色は？", text: "あ".repeat(6_000) }],
  });

  expect(response.status).toBe(413);
  expect(calls).toEqual([]);
});

test("the stop button still sends nothing while a Claude pane is blocked", async () => {
  const calls: string[] = [];
  const store = createFakeStore(stateWith(claudePane()));
  const { app } = createTestApp({
    store,
    panes: {
      stop: async () => {
        calls.push("stop");
      },
    },
  });

  const response = await app.request("/api/panes/w1:p1/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  // 回答の経路が Esc を使うので、止まっているペインに停止が Esc を送らない前提を固定する。
  expect(response.status).toBe(200);
  expect(calls).toEqual([]);
});
