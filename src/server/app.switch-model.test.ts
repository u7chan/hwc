import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentModelsClient } from "./agent-models";
import { createFakeStore, createTestApp, emptyChat, pane, state } from "./app.test-helpers";
import { applySwitchHook } from "./chat/claude-switch";
import type { ChatSnapshot } from "./chat/contract";
import type { AppState, PaneState } from "./herdr/state";

const SESSION = "session-1";
const body = { model: { provider: "claude", id: "opus" }, effort: "xhigh" };

let root: string;

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), "hwc-switch-route-")), "model-switch");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

function claudePane(overrides: Partial<PaneState> = {}): PaneState {
  return { ...pane, agent: "claude", agentStatus: "idle", chat: true, ...overrides };
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
  options: {
    pane?: PaneState;
    source?: boolean;
    switchRoot?: boolean;
    // 実機の hook を持つか。持たないペインでは確認ダイアログが開いたままになる。
    hook?: boolean;
    models?: Partial<ReturnType<typeof createAgentModelsClient>>;
    model?: string | null;
    effort?: string | null;
  } = {},
) {
  const target = options.pane ?? claudePane();
  const store = createFakeStore(stateWith(target));
  if (options.source !== false && target.agent !== null) {
    store.setChatSource(target.id, {
      agent: target.agent === "claude" ? "claude" : "pi",
      ...(target.agent === "claude" ? { sessionId: SESSION } : { path: "/tmp/s.jsonl" }),
    } as never);
  }
  const calls: string[] = [];
  const outputs: string[] = [];
  const snapshot = async (): Promise<ChatSnapshot> => ({
    ...emptyChat,
    model: options.model === undefined ? "claude-haiku-5-5" : options.model,
    effort: options.effort === undefined ? "high" : options.effort,
  });
  const { app } = createTestApp({
    store,
    models: { ...createAgentModelsClient(), ...options.models },
    claudeSwitchRoot: options.switchRoot === false ? undefined : root,
    claude: { snapshot, localCommandOutputs: async () => [...outputs] },
    panes: {
      directory: async () => "/work",
      sendKeys: async ({ keys }) => {
        calls.push(`keys:${keys.join("+")}`);
      },
      send: async ({ text, submit }) => {
        calls.push(`send:${submit}:${text}`);
        const model = /^\/model (\w+)$/.exec(text)?.[1];
        if (model !== undefined && options.hook !== false) {
          const input = (event: string) => ({
            session_id: SESSION,
            hook_event_name: event,
            to_model: `claude-${model}-5-5`,
            requested_model: model,
            source: "command",
          });
          await applySwitchHook(root, input("PreModelSwitch"), Date.now());
          await applySwitchHook(root, input("PostModelSwitch"), Date.now());
        }
        const effort = /^\/effort (\w+)$/.exec(text)?.[1];
        if (effort !== undefined) outputs.push(`Set effort level to ${effort} (saved)`);
      },
    },
  });
  const post = (payload: unknown, id = target.id) =>
    app.request(`/api/panes/${id}/switch-model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const chat = (id = target.id) => app.request(`/api/panes/${id}/chat`);
  return { post, chat, calls };
}

test("an idle Claude pane is switched by sending /model and then /effort", async () => {
  const { post, calls } = fixture();

  const response = await post(body);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(calls).toEqual(["send:true:/model opus", "send:true:/effort xhigh"]);
});

test("a done Claude pane can be switched too", async () => {
  const { post } = fixture({ pane: claudePane({ agentStatus: "done" }) });

  expect((await post(body)).status).toBe(200);
});

test("the conversation shows the switched model and effort until the next reply", async () => {
  const { post, chat } = fixture();
  expect(((await (await chat()).json()) as ChatSnapshot).model).toBe("claude-haiku-5-5");

  await post(body);
  const shown = (await (await chat()).json()) as ChatSnapshot;

  expect(shown.model).toBe("claude-opus-5-5");
  expect(shown.effort).toBe("xhigh");
});

test.each([
  ["not an object", "text"],
  ["without an effort", { model: body.model }],
  [
    "with a model that is not an alias",
    { ...body, model: { provider: "claude", id: "claude-opus-5-5" } },
  ],
  ["with an effort that could carry a second command", { ...body, effort: "high\n/clear" }],
])("a body %s is a bad request and touches nothing", async (_name, payload) => {
  const { post, calls } = fixture();

  expect((await post(payload)).status).toBe(400);
  expect(calls).toEqual([]);
});

test("an effort that is not a candidate is refused before anything is sent", async () => {
  const { post, calls } = fixture();

  const response = await post({ ...body, effort: "extreme" });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "effort_not_available" });
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

test.each(["working", "blocked", "unknown"] as const)(
  "a %s pane is refused and nothing is sent",
  async (agentStatus) => {
    const { post, calls } = fixture({ pane: claudePane({ agentStatus }) });

    const response = await post(body);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_idle" });
    expect(calls).toEqual([]);
  },
);

test("a pane whose conversation cannot be read is not available", async () => {
  const { post, calls } = fixture({ source: false });

  const response = await post(body);

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_available" });
  expect(calls).toEqual([]);
});

test("a server without the hook directory does not switch", async () => {
  const { post, calls } = fixture({ switchRoot: false });

  expect((await post(body)).status).toBe(409);
  expect(calls).toEqual([]);
});

test("a failure of the switch itself is passed through with its own status", async () => {
  // 待ちの挙動は model-switch.test.ts が時計を差し替えて確かめる。ここは状態の対応だけを見る。
  const { post, calls } = fixture({
    models: { list: async () => Promise.reject(new Error("down")) },
  });

  const response = await post(body);

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "candidates_unavailable" });
  expect(calls).toEqual([]);
});
