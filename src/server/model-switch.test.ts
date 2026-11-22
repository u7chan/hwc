import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentModel } from "../shared/agents";
import { applySwitchHook } from "./chat/claude-switch";
import type { ChatMessage, ChatSnapshot } from "./chat/contract";
import { createLaunchModels } from "./launch-models";
import { createModelSwitcher, type SwitchInput } from "./model-switch";

const PANE = "w1:p1";
const SESSION = "session-1";
const alias = (id: string): AgentModel => ({ provider: "claude", id });
const OPUS = alias("opus");

let root: string;

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), "hwc-model-switch-")), "model-switch");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

type World = {
  // 現在のモデルと effort（transcript の最後の assistant）。
  model: string | null;
  effort: string | null;
  messages: ChatMessage[];
  // 実機の hook を持つか。持たないペインでは、確認ダイアログが開いたままになる。
  hook: boolean;
  // hook が呼ばれなくても、CLI が `/model` の結果（`Set model to ...`）を書くか。すでにそのモデルの
  // セッション、または確認ダイアログが開かない（キャッシュが冷えた）ペインで起きる。
  modelEcho: boolean;
  // `/effort` の結果を CLI が書くか。文字列なら、頼んだ水準ではなくその水準を書く。
  effortResult: boolean | string;
  candidates: AgentModel[] | Error;
  efforts: string[] | Error;
  snapshot: Error | null;
  sendFails: string | null;
  blocked: boolean;
  // `/model` を送った後に、会話の取得が失敗するか。
  chatBreaksAfterSend: boolean;
  // `/model` を取り消したときの結果（`Kept model as ...`）を CLI が書くか。確認ダイアログを
  // 開いたまま Esc で閉じた場合に起きる。
  modelCancel: boolean;
  // 応答待ち（権限確認など）が会話に現れているか。
  pending: boolean;
};

function setup(overrides: Partial<World> = {}) {
  const world: World = {
    model: "claude-haiku-5-5",
    effort: "high",
    messages: [],
    hook: true,
    modelEcho: false,
    effortResult: true,
    candidates: ["fable", "opus", "sonnet", "haiku"].map(alias),
    efforts: ["low", "medium", "high", "xhigh", "max"],
    snapshot: null,
    sendFails: null,
    blocked: false,
    chatBreaksAfterSend: false,
    modelCancel: false,
    pending: false,
    ...overrides,
  };
  const calls: string[] = [];
  const outputs: string[] = [];
  let clock = 10_000;
  const launchModels = createLaunchModels();

  // 実機の hook と同じ入力で呼ぶ。CLI は 1 回の `/model` で PreModelSwitch を 2 回呼ぶ。
  const sessionOf = (paneId: string) => (paneId === PANE ? SESSION : "session-2");
  const hookInput = (event: string, session: string, to: string, requested: string) => ({
    session_id: session,
    hook_event_name: event,
    from_model: world.model,
    to_model: to,
    requested_model: requested,
    source: "command",
  });
  const runHook = async (session: string, requested: string) => {
    const resolved = `claude-${requested}-5-5`;
    await applySwitchHook(root, hookInput("PreModelSwitch", session, resolved, requested), clock);
    await applySwitchHook(
      root,
      hookInput("PreModelSwitch", session, "claude-sonnet-5-5", requested),
      clock,
    );
    await applySwitchHook(root, hookInput("PostModelSwitch", session, resolved, requested), clock);
  };

  const switcher = createModelSwitcher(
    {
      root,
      launchModels,
      models: {
        list: async () => {
          if (world.candidates instanceof Error) throw world.candidates;
          return world.candidates;
        },
        efforts: async () => {
          if (world.efforts instanceof Error) throw world.efforts;
          return world.efforts;
        },
      },
      panes: {
        send: async ({ paneId, text, submit }) => {
          calls.push(`send:${paneId}:${submit}:${text}`);
          if (world.sendFails !== null && text.startsWith(world.sendFails))
            throw new Error("socket");
          const model = /^\/model (\w+)$/.exec(text)?.[1];
          if (model !== undefined && world.hook) await runHook(sessionOf(paneId), model);
          if (model !== undefined && world.chatBreaksAfterSend) world.snapshot = new Error("gone");
          if (model !== undefined && world.modelCancel) {
            outputs.push("Kept model as `Haiku 5.5`");
          }
          if (model !== undefined && world.modelEcho) {
            outputs.push(`Set model to \`${model}\` and saved as your default for new sessions`);
          }
          const effort = /^\/effort (\w+)$/.exec(text)?.[1];
          if (effort !== undefined && world.effortResult !== false) {
            const level = typeof world.effortResult === "string" ? world.effortResult : effort;
            outputs.push(`Set effort level to ${level} (saved as your default for new sessions)`);
          }
        },
        sendKeys: async ({ keys }) => {
          calls.push(`keys:${keys.join("+")}`);
        },
      },
      chat: {
        snapshot: async () => {
          if (world.snapshot !== null) throw world.snapshot;
          return {
            etag: "e1",
            messages: world.messages,
            model: world.model,
            effort: world.effort,
            truncated: false,
            context: null,
            compaction: null,
            ...(world.pending
              ? { pending: { kind: "tool", toolUseId: "t1", tool: "Bash", summary: "ls" } }
              : {}),
          } satisfies ChatSnapshot;
        },
        localCommandOutputs: async () => [...outputs],
      },
    },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pollIntervalMs: 100,
      switchTimeoutMs: 1_000,
      effortTimeoutMs: 500,
    },
  );

  const input = (
    request: { model: AgentModel; effort: string },
    extra: Partial<SwitchInput> = {},
  ): SwitchInput => ({
    paneId: PANE,
    sessionId: SESSION,
    directory: "/work",
    idle: true,
    blocked: () => world.blocked,
    request,
    ...extra,
  });

  return {
    world,
    calls,
    switcher,
    launchModels,
    input,
    tick: (ms: number) => {
      clock += ms;
    },
    snapshot: (): ChatSnapshot => ({
      etag: "e1",
      messages: world.messages,
      model: world.model,
      effort: world.effort,
      truncated: false,
      context: null,
      compaction: null,
    }),
  };
}

const sends = (calls: string[]) =>
  calls
    .filter((call) => call.startsWith("send:"))
    .map((call) => call.split(":").slice(4).join(":"));

describe("what is sent", () => {
  test("a new model is sent first and its effort after it, each as an ordinary submission", async () => {
    const t = setup();

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(outcome).toEqual({ ok: true });
    expect(t.calls).toEqual([`send:${PANE}:true:/model opus`, `send:${PANE}:true:/effort xhigh`]);
  });

  test("the effort is sent with a new model even when the shown effort already matches", async () => {
    // CLI は effort を指定していないセッションでは、モデルごとの保存値へ動かす。
    const t = setup({ effort: "high" });

    await t.switcher.switch(t.input({ model: OPUS, effort: "high" }));

    expect(sends(t.calls)).toEqual(["/model opus", "/effort high"]);
  });

  test("changing only the effort sends only the effort and leaves the dialog alone", async () => {
    const t = setup({ model: "claude-opus-5-5", effort: "high" });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "low" }));

    expect(outcome).toEqual({ ok: true });
    expect(sends(t.calls)).toEqual(["/effort low"]);
    // 印は置かない。モデルを変えないので、hook に許可させるものが無い。
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });

  test("changing nothing sends nothing", async () => {
    const t = setup({ model: "claude-opus-5-5", effort: "high" });

    expect(await t.switcher.switch(t.input({ model: OPUS, effort: "high" }))).toEqual({ ok: true });
    expect(t.calls).toEqual([]);
  });

  test("the mark that lets the hook skip the dialog is gone once the switch is recorded", async () => {
    const t = setup();

    await t.switcher.switch(t.input({ model: OPUS, effort: "high" }));

    expect(await readdir(root)).toEqual([]);
  });
});

describe("what is checked before anything is sent", () => {
  test("a pane that is not idle is refused", async () => {
    const t = setup();

    const outcome = await t.switcher.switch(
      t.input({ model: OPUS, effort: "low" }, { idle: false }),
    );

    expect(outcome).toEqual({ ok: false, status: 409, error: "not_idle" });
    expect(t.calls).toEqual([]);
  });

  test("a model that is not a candidate is refused", async () => {
    const t = setup({ candidates: [alias("sonnet")] });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "low" }));

    expect(outcome).toEqual({ ok: false, status: 400, error: "model_not_available" });
    expect(t.calls).toEqual([]);
  });

  test("an effort that is not a candidate is refused", async () => {
    const t = setup({ efforts: ["low", "high"] });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "max" }));

    expect(outcome).toEqual({ ok: false, status: 400, error: "effort_not_available" });
    expect(t.calls).toEqual([]);
  });

  test("candidates that cannot be read stop the switch", async () => {
    const t = setup({ candidates: new Error("down") });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "low" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "candidates_unavailable" });
    expect(t.calls).toEqual([]);
  });

  test("a conversation that cannot be read stops the switch", async () => {
    const t = setup({ snapshot: new Error("gone") });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "low" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "chat_unavailable" });
    expect(t.calls).toEqual([]);
  });
});

describe("when the switch cannot be confirmed", () => {
  test("without the hook the effort is never sent, and an open dialog is closed with Esc", async () => {
    const t = setup({ hook: false, blocked: true });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "switch_unconfirmed" });
    expect(t.calls).toEqual([`send:${PANE}:true:/model opus`, "keys:esc"]);
    expect(await readdir(root)).toEqual([]);
  });

  test("a session already on the model writes no hook record, and the echo confirms it", async () => {
    // transcript はまだ前のモデルの応答で終わっている。画面とセッションのモデルがずれている。
    const t = setup({ hook: false, modelEcho: true });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(outcome).toEqual({ ok: true });
    expect(sends(t.calls)).toEqual(["/model opus", "/effort xhigh"]);
    expect(await readdir(root)).toEqual([]);
    // 解決済みの id は分からないので、頼んだエイリアスで補う。
    expect(t.switcher.apply(PANE, SESSION, t.snapshot()).model).toBe("opus");
  });

  test("a cancelled switch is not a confirmation", async () => {
    // 確認ダイアログを閉じると、CLI は `Set model to` ではなく `Kept model as` を書く。
    const t = setup({ hook: false, modelCancel: true });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "switch_unconfirmed" });
    expect(sends(t.calls)).toEqual(["/model opus"]);
  });

  test("Esc is not sent when a new message arrived while waiting, which may be another prompt", async () => {
    // 待っている間に別のクライアントが発言して、権限確認に入った場合。
    const t = setup({
      hook: false,
      blocked: true,
      messages: [{ id: "m1", role: "user", text: "続けて", at: 10_000_000_000_000 }],
    });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "switch_unconfirmed" });
    expect(t.calls).toEqual([`send:${PANE}:true:/model opus`]);
  });

  test("Esc is not sent while a question or permission wait is pending", async () => {
    const t = setup({ hook: false, blocked: true, pending: true });

    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(t.calls).toEqual([`send:${PANE}:true:/model opus`]);
  });

  test("Esc is not sent when the conversation can no longer be read", async () => {
    const t = setup({ hook: false, blocked: true, chatBreaksAfterSend: true });

    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(t.calls).toEqual([`send:${PANE}:true:/model opus`]);
  });

  test("a message from before the request does not hold Esc back", async () => {
    const t = setup({
      hook: false,
      blocked: true,
      messages: [{ id: "m0", role: "agent", text: "前の応答", at: 1 }],
    });

    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(t.calls.at(-1)).toBe("keys:esc");
  });

  test("Esc is not sent when the pane is not waiting on a dialog", async () => {
    const t = setup({ hook: false, blocked: false });

    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(t.calls).toEqual([`send:${PANE}:true:/model opus`]);
  });

  test("the display follows nothing when the model never switched", async () => {
    const t = setup({ hook: false });

    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(t.switcher.apply(PANE, SESSION, t.snapshot()).model).toBe("claude-haiku-5-5");
  });

  test("an effort that is not confirmed still leaves the display on the model that did switch", async () => {
    const t = setup({ effortResult: false, blocked: true });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "switch_unconfirmed" });
    expect(t.calls.at(-1)).toBe("keys:esc");
    const shown = t.switcher.apply(PANE, SESSION, t.snapshot());
    // 実際のモデルを名乗り、確かめられていない effort は補わない。
    expect(shown.model).toBe("claude-opus-5-5");
    expect(shown.effort).toBe("high");
  });

  test("an effort answered with another level is not a confirmation", async () => {
    // CLI が頼んだ水準ではなく、別の水準へ丸めた場合。
    const t = setup({ model: "claude-opus-5-5", effortResult: "high" });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "max" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "switch_unconfirmed" });
  });

  test("a send that fails is reported and leaves no mark behind", async () => {
    const t = setup({ sendFails: "/model" });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "send_failed" });
    expect(await readdir(root)).toEqual([]);
  });

  test("a failed effort send is reported after the model switched", async () => {
    const t = setup({ sendFails: "/effort" });

    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "send_failed" });
  });
});

describe("what the screen shows until the next reply", () => {
  test("the switched model and effort replace the last reply's until a newer reply is recorded", async () => {
    const t = setup();
    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    const shown = t.switcher.apply(PANE, SESSION, t.snapshot());

    expect(shown.model).toBe("claude-opus-5-5");
    expect(shown.effort).toBe("xhigh");
    // 補った値は本文が変わるので、補う前の etag に 304 を返させない。
    expect(shown.etag).not.toBe("e1");

    t.tick(1_000);
    const reply: ChatMessage = { id: "m1", role: "agent", text: "はい", at: 10_000_000_000_000 };
    t.world.messages = [reply];
    t.world.model = "claude-opus-5-5";
    t.world.effort = "xhigh";
    expect(t.switcher.apply(PANE, SESSION, t.snapshot())).toEqual(t.snapshot());
  });

  test("an effort-only switch before any reply keeps showing the model that was switched to", async () => {
    const t = setup();
    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    // 画面は Opus を出している。effort だけを変えても、Haiku へ戻らない。
    const outcome = await t.switcher.switch(t.input({ model: OPUS, effort: "low" }));

    expect(outcome).toEqual({ ok: true });
    expect(sends(t.calls).slice(-1)).toEqual(["/effort low"]);
    const shown = t.switcher.apply(PANE, SESSION, t.snapshot());
    expect(shown.model).toBe("claude-opus-5-5");
    expect(shown.effort).toBe("low");
  });

  test("a reply from before the switch does not end it", async () => {
    const t = setup({ messages: [{ id: "m0", role: "agent", text: "前の応答", at: 1 }] });
    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(t.switcher.apply(PANE, SESSION, t.snapshot()).model).toBe("claude-opus-5-5");
  });

  test("another session of the same pane is left as it is", async () => {
    const t = setup();
    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    expect(t.switcher.apply(PANE, "session-2", t.snapshot())).toEqual(t.snapshot());
  });

  test("a new conversation in the pane starts from the switched model", async () => {
    const t = setup();
    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));

    // /new の直後は会話にモデルが無い。起動時の指定の代わりに、切り替えた値を預かる。
    const empty: ChatSnapshot = { ...t.snapshot(), model: null, effort: null };
    expect(t.launchModels.apply(PANE, empty)).toMatchObject({ model: "opus", effort: "xhigh" });
  });
});

describe("one switch at a time", () => {
  test("a second request for the same pane is refused while the first runs", async () => {
    const t = setup();

    const first = t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));
    const second = await t.switcher.switch(t.input({ model: alias("sonnet"), effort: "low" }));

    expect(second).toEqual({ ok: false, status: 409, error: "in_progress" });
    expect(await first).toEqual({ ok: true });
    expect(sends(t.calls)).toEqual(["/model opus", "/effort xhigh"]);
  });

  test("another pane is not held up", async () => {
    const t = setup();

    const first = t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));
    const other = await t.switcher.switch(
      t.input({ model: OPUS, effort: "xhigh" }, { paneId: "w1:p2", sessionId: "session-2" }),
    );

    expect(other).toEqual({ ok: true });
    expect(await first).toEqual({ ok: true });
  });

  test("a finished switch can be followed by the next one", async () => {
    const t = setup();
    await t.switcher.switch(t.input({ model: OPUS, effort: "xhigh" }));
    t.world.model = "claude-opus-5-5";
    t.world.effort = "xhigh";

    expect(await t.switcher.switch(t.input({ model: OPUS, effort: "low" }))).toEqual({ ok: true });
    expect(sends(t.calls).at(-1)).toBe("/effort low");
  });
});
