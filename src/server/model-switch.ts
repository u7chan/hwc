import { modelKey } from "../shared/agents";
import {
  effortCommand,
  modelCommand,
  modelSwitchPlan,
  type ModelSwitchRequest,
} from "../shared/model-switch";
import type { AgentModelsClient } from "./agent-models";
import { clearSwitch, readDone, writeAllow } from "./chat/claude-switch";
import type { ChatSnapshot, SessionChatClient } from "./chat/contract";
import type { PaneClient } from "./herdr/panes";
import type { createLaunchModels } from "./launch-models";

// hook は `/model` を送ってから 1 秒に満たない間に完了を記録する（実機 2.1.330）。確認ダイアログが
// 開いてしまう構成（hook を持たない古いペイン）では記録が来ないので、上限で諦める。
const SWITCH_TIMEOUT_MS = 8_000;
const EFFORT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

// TBD: ローカルコマンドの結果の文言は CLI の版で変わり得る。2.1.330 の `Set effort level to <level>` と
// `Set model to ...` だけを確かめた。変わると、切り替えは通るが hwc は確認できず、端末で確かめるよう
// 502 を返す。取り消しは `Kept model as ...` で、`Set model to` ではないので成功にしない。
const EFFORT_SET = /^Set effort level to ([a-z]+)\b/;
const MODEL_SET = /^Set model to /;

export type SwitchOutcome =
  | { ok: true }
  // 400: 候補に無い。409: 実行中などで切り替えられない・処理中。502: Herdr・会話・候補の
  // 取得に失敗した、または切り替えが済んだと確かめられなかった。
  | { ok: false; status: 400 | 409 | 502; error: string };

export type SwitchInput = {
  paneId: string;
  sessionId: string;
  // 候補を読むペインの作業ディレクトリ。
  directory: string;
  // Herdr の状態が idle か done のときだけ切り替える。
  idle: boolean;
  // 確かめられなかったとき、確認ダイアログが開いたままかを見るための、最新の状態。
  blocked: () => boolean;
  request: ModelSwitchRequest;
};

type SwitchChat = SessionChatClient & {
  localCommandOutputs: NonNullable<SessionChatClient["localCommandOutputs"]>;
};

type Clients = {
  panes: Pick<PaneClient, "send" | "sendKeys">;
  chat: SwitchChat;
  models: Pick<AgentModelsClient, "list" | "efforts">;
  launchModels: Pick<ReturnType<typeof createLaunchModels>, "apply" | "remember">;
  // hook との受け渡しの置き場（docs/adr/claude-integration.md）。
  root: string;
};

// model / effort が null のものは、切り替えていないか、結果を確かめられていないので補わない。
type Switched = { sessionId: string; at: number; model: string | null; effort: string | null };

export type ModelSwitcher = ReturnType<typeof createModelSwitcher>;

export function hasLocalCommandOutputs(chat: SessionChatClient | undefined): chat is SwitchChat {
  return chat?.localCommandOutputs !== undefined;
}

// 実行中の Claude のモデルと effort を、入力欄へ `/model` と `/effort` を送って切り替える
// （docs/adr/claude-integration.md）。キーでピッカーを操作しない。モデルの確認ダイアログは、
// hwc の画面で確かめたものだけ hook が許可して開かせない。完了は hook の記録（モデル）と
// transcript のローカルコマンドの結果（effort）で確かめ、確かめられなければ成功にしない。
export function createModelSwitcher(
  clients: Clients,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    switchTimeoutMs?: number;
    effortTimeoutMs?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const switchTimeoutMs = options.switchTimeoutMs ?? SWITCH_TIMEOUT_MS;
  const effortTimeoutMs = options.effortTimeoutMs ?? EFFORT_TIMEOUT_MS;

  const inFlight = new Map<string, Promise<SwitchOutcome>>();
  // 切り替えた値。次の応答が transcript に載るまでの表示を補う。会話の正は transcript なので、
  // 応答が載ったら使わない。
  const switched = new Map<string, Switched>();

  // 確認ダイアログが開いたままなら閉じる。開いたままだと、hwc からは答えられず、端末へ戻るしか
  // なくなる。Esc は blocked のときだけ、さらに頼んだ後に新しい発言か応答待ちが現れていないときだけ
  // 送る（docs/adr/agent-input.md）。blocked には権限確認や質問の待ちも含まれ、待っている間に
  // 別のクライアントが発言して権限確認に入っていると、その確認を Esc で拒否してしまう。
  // 質問への回答が pending を照合してから Esc を送るのと同じく、確かめられないときは送らない。
  const dismissDialog = async (input: SwitchInput, since: number) => {
    if (!input.blocked()) return;
    try {
      const snapshot = await clients.chat.snapshot(input.sessionId);
      if (snapshot.pending !== undefined) return;
      if (snapshot.messages.some((message) => message.at >= since)) return;
    } catch {
      return;
    }
    await clients.panes.sendKeys({ paneId: input.paneId, keys: ["esc"] }).catch(() => {});
  };

  const modelEchoed = async (sessionId: string, since: number): Promise<boolean> => {
    try {
      return (await clients.chat.localCommandOutputs(sessionId, since)).some((output) =>
        MODEL_SET.test(output),
      );
    } catch {
      return false;
    }
  };

  const switchModel = async (
    input: SwitchInput,
  ): Promise<{ ok: true; resolved: string } | { ok: false; outcome: SwitchOutcome }> => {
    const { paneId, sessionId, request } = input;
    const alias = request.model.id;
    const sentAt = now();
    try {
      await writeAllow(clients.root, sessionId, alias, sentAt);
      await clients.panes.send({ paneId, text: modelCommand(request.model), submit: true });
    } catch {
      await clearSwitch(clients.root, sessionId).catch(() => {});
      return { ok: false, outcome: failure("send_failed") };
    }

    // 完了は hook の記録で知る。すでにそのモデルのセッションでは、CLI は切り替えず hook も呼ばないが、
    // `Set model to ...` は書く（実機 2.1.330）。transcript の画面とセッションのモデルは、次の応答が
    // 載るまでずれ得る（BFF の再起動、端末での切り替え）ので、こちらでも確かめる。
    const deadline = sentAt + switchTimeoutMs;
    for (;;) {
      await sleep(pollIntervalMs);
      const done = await readDone(clients.root, sessionId, sentAt);
      if (done !== null && done.requested === alias) {
        await clearSwitch(clients.root, sessionId).catch(() => {});
        return { ok: true, resolved: done.model };
      }
      if (await modelEchoed(sessionId, sentAt)) {
        await clearSwitch(clients.root, sessionId).catch(() => {});
        // 解決済みの id は分からない。頼んだエイリアスで補い、応答が載れば実際のモデルになる。
        return { ok: true, resolved: alias };
      }
      if (now() >= deadline) break;
    }
    await clearSwitch(clients.root, sessionId).catch(() => {});
    await dismissDialog(input, sentAt);
    return { ok: false, outcome: failure("switch_unconfirmed") };
  };

  const switchEffort = async (input: SwitchInput): Promise<SwitchOutcome> => {
    const { paneId, sessionId, request } = input;
    const sentAt = now();
    try {
      await clients.panes.send({ paneId, text: effortCommand(request.effort), submit: true });
    } catch {
      return failure("send_failed");
    }

    const deadline = sentAt + effortTimeoutMs;
    for (;;) {
      await sleep(pollIntervalMs);
      let outputs: string[];
      try {
        outputs = await clients.chat.localCommandOutputs(sessionId, sentAt);
      } catch {
        return failure("chat_unavailable");
      }
      if (outputs.some((output) => EFFORT_SET.exec(output)?.[1] === request.effort)) {
        return { ok: true };
      }
      if (now() >= deadline) break;
    }
    await dismissDialog(input, sentAt);
    return failure("switch_unconfirmed");
  };

  const run = async (input: SwitchInput): Promise<SwitchOutcome> => {
    const { paneId, sessionId, request } = input;
    if (!input.idle) return conflict("not_idle");

    // 候補は起動のときと同じ読み取り。送る文字列にコマンドを組み立てるので、候補にある
    // 値だけを通す。
    try {
      const models = await clients.models.list("claude", input.directory);
      if (!models.some((model) => modelKey(model) === modelKey(request.model))) {
        return { ok: false, status: 400, error: "model_not_available" };
      }
      const efforts = await clients.models.efforts("claude", request.model, input.directory);
      if (!efforts.includes(request.effort)) {
        return { ok: false, status: 400, error: "effort_not_available" };
      }
    } catch {
      return failure("candidates_unavailable");
    }

    let current: ChatSnapshot;
    try {
      current = apply(
        paneId,
        sessionId,
        clients.launchModels.apply(paneId, await clients.chat.snapshot(sessionId)),
      );
    } catch {
      return failure("chat_unavailable");
    }
    const plan = modelSwitchPlan({ model: current.model, effort: current.effort }, request);

    let resolved: string | null = null;
    if (plan.model) {
      const result = await switchModel(input);
      if (!result.ok) return result.outcome;
      resolved = result.resolved;
      // モデルは切り替わった。effort の確認で失敗しても、表示は切り替わった事実に合わせる。
      // effort は CLI がモデルごとの保存値へ動かし得るので、確かめるまで補わない。
      switched.set(paneId, { sessionId, at: now(), model: resolved, effort: null });
      clients.launchModels.remember(paneId, request.model, null);
    }
    if (plan.effort) {
      const outcome = await switchEffort(input);
      if (!outcome.ok) return outcome;
    }
    // モデルを切り替えなかったときも、いま表示しているモデルを引き継ぐ。次の応答が載る前に
    // effort だけを切り替えると、補いが前のモデルへ戻ってしまう。
    switched.set(paneId, {
      sessionId,
      at: now(),
      model: resolved ?? current.model,
      effort: request.effort,
    });
    clients.launchModels.remember(paneId, request.model, request.effort);
    return { ok: true };
  };

  // 切り替えのあとに agent の応答が載れば、モデルも effort もセッションの値が正。
  // それまでの間だけ、切り替えた値で表示を補う。etag も変えて、補う前の etag に 304 を返さない。
  const apply = (paneId: string, sessionId: string, snapshot: ChatSnapshot): ChatSnapshot => {
    const override = switched.get(paneId);
    if (override === undefined || override.sessionId !== sessionId) return snapshot;
    if (
      snapshot.messages.some((message) => message.role === "agent" && message.at >= override.at)
    ) {
      return snapshot;
    }
    // 旧モデル・旧 effort の 1h キャッシュの期限は、切り替え後の会話には当てはまらない。
    // 新しい応答が載るまでの間は出さない（docs/adr/claude-integration.md）。
    const { cacheExpiresAt: _cacheExpiresAt, ...rest } = snapshot;
    return {
      ...rest,
      etag: `${snapshot.etag}+switch${override.at}`,
      model: override.model ?? snapshot.model,
      effort: override.effort ?? snapshot.effort,
    };
  };

  return {
    apply,
    async switch(input: SwitchInput): Promise<SwitchOutcome> {
      // ペインごとに 1 本。重ねて送ると、2 つの `/model` が入力欄で混ざる。
      if (inFlight.has(input.paneId)) return conflict("in_progress");
      const result = run(input);
      inFlight.set(input.paneId, result);
      try {
        return await result;
      } finally {
        inFlight.delete(input.paneId);
      }
    },
  };
}

function conflict(error: string): SwitchOutcome {
  return { ok: false, status: 409, error };
}

function failure(error: string): SwitchOutcome {
  return { ok: false, status: 502, error };
}
