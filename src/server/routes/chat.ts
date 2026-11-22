import { attachAttachmentSizes } from "../attachments";
import { readActivity } from "../chat/activity";
import { OpencodeServiceNotRunningError } from "../chat/opencode";
import { attachMessageFiles } from "../message-files";
import {
  type AgentModel,
  isAgentModel,
  type ModelAgentKind,
  supportsModelSelection,
} from "../../shared/agents";
import { parseAnswerRequest } from "../../shared/answer";
import { parseModelSwitchRequest } from "../../shared/model-switch";
import { findPane } from "../herdr/state";
import type { AppContext, IdContext, PlainContext } from "./context";

export function createChatHandlers(ctx: AppContext) {
  const {
    store,
    panes,
    chat,
    opencode,
    codex,
    claude,
    models,
    modelLabels,
    homeDirectory,
    projects,
    previewRoots,
    attachmentsRoot,
    launchModels,
    piDefaults,
    questionAnswerer,
    modelSwitcher,
    resolvePane,
    paneFailure,
    matchesEtag,
  } = ctx;

  const listModels = async (
    c: PlainContext,
    agent: ModelAgentKind,
    directory: () => Promise<string>,
  ) => {
    try {
      if (!models) return c.json({ error: "models_unavailable" }, 502);
      return c.json({ models: await models.list(agent, await directory()) });
    } catch (error) {
      if (agent === "opencode" && error instanceof OpencodeServiceNotRunningError)
        return c.json({ error: "opencode_not_running" }, 502);
      return c.json({ error: "models_unavailable" }, 502);
    }
  };

  const listEfforts = async (
    c: PlainContext,
    agent: ModelAgentKind,
    model: AgentModel,
    directory: () => Promise<string>,
  ) => {
    try {
      if (!models) return c.json({ error: "efforts_unavailable" }, 502);
      return c.json({ efforts: await models.efforts(agent, model, await directory()) });
    } catch {
      return c.json({ error: "efforts_unavailable" }, 502);
    }
  };

  return {
    models: async (c: IdContext) => {
      const agent = c.req.query("agent");
      if (!supportsModelSelection(agent)) return c.json({ error: "invalid_request" }, 400);
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId } = resolved;
      return listModels(c, agent, () => panes.directory({ paneId }));
    },
    efforts: async (c: IdContext) => {
      const agent = c.req.query("agent");
      const model = { provider: c.req.query("provider"), id: c.req.query("model") };
      if (!supportsModelSelection(agent) || !isAgentModel(model))
        return c.json({ error: "invalid_request" }, 400);
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId } = resolved;
      return listEfforts(c, agent, model, () => panes.directory({ paneId }));
    },
    // 設定画面にはペインが無い。hwc の作業ディレクトリで読むと hwc リポジトリの
    // プロジェクト設定を拾うので、ホームで読む。
    homeModels: async (c: PlainContext) => {
      const agent = c.req.query("agent");
      if (!supportsModelSelection(agent)) return c.json({ error: "invalid_request" }, 400);
      return listModels(c, agent, async () => homeDirectory);
    },
    // 候補を読む口とは分ける。ラベルは表示の補いだけなので、読めなくても候補は返す。
    homeModelLabels: async (c: PlainContext) => {
      if (c.req.query("agent") !== "claude") {
        return c.json({ error: "invalid_request" }, 400);
      }
      if (modelLabels === undefined) return c.json({ labels: null });
      try {
        return c.json({ labels: await modelLabels.read() });
      } catch {
        return c.json({ labels: null });
      }
    },
    homeEfforts: async (c: PlainContext) => {
      const agent = c.req.query("agent");
      const model = { provider: c.req.query("provider"), id: c.req.query("model") };
      if (!supportsModelSelection(agent) || !isAgentModel(model))
        return c.json({ error: "invalid_request" }, 400);
      return listEfforts(c, agent, model, async () => homeDirectory);
    },
    chat: async (c: IdContext) => {
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId, pane } = resolved;

      // セッションの在り処はクライアントから受け取らず、BFF がペイン id から引く。
      const source = store.chatSource(paneId);
      if (!pane.chat || source === null) return c.json({ error: "no_chat" }, 404);

      const client = { pi: chat, opencode, codex, claude }[source.agent];
      if (client === undefined) return c.json({ error: "chat_unavailable" }, 502);

      try {
        const live = await client.snapshot(source.agent === "pi" ? source.path : source.sessionId);
        // 解決済みの既定は捨てる。預かりは残すので、/new の後は読み直せる（docs/adr/agent-launch.md）。
        piDefaults.dropResolved(paneId, live.model);
        const launched = launchModels.apply(paneId, live);
        // 切り替えた値は、次の応答が transcript に載るまで表示を補う（docs/adr/claude-integration.md）。
        const snapshot =
          source.agent === "claude" && modelSwitcher !== null
            ? modelSwitcher.apply(paneId, source.sessionId, launched)
            : launched;
        // 添付のチップに出すサイズは保存済みファイルの実バイト数。名前から引く。
        const withSizes = await attachAttachmentSizes(snapshot, {
          root: attachmentsRoot,
          paneId,
        });
        // 本文が指しているファイルを足す。中身が変わると etag も変わり、次の取得で新しい URL になる。
        const withFiles = await attachMessageFiles(
          withSizes,
          store.workspaceRoot(paneId),
          previewRoots,
        );
        c.header("ETag", `"${withFiles.etag}"`);
        if (matchesEtag(c.req.header("if-none-match"), withFiles.etag)) {
          return c.body(null, 304);
        }
        return c.json(withFiles);
      } catch {
        return c.json({ error: "chat_unavailable" }, 502);
      }
    },
    // AskUserQuestion に Esc で閉じて本文で答える（docs/adr/claude-integration.md）。Claude だけ。
    answerQuestion: async (c: IdContext) => {
      const request = parseAnswerRequest(await c.req.json().catch(() => null));
      if (request === null) return c.json({ error: "invalid_request" }, 400);

      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId, pane } = resolved;
      if (pane.agent !== "claude") return c.json({ error: "not_claude" }, 400);

      // セッションの在り処はクライアントから受け取らず、BFF がペイン id から引く。
      const source = store.chatSource(paneId);
      if (!pane.chat || source?.agent !== "claude" || questionAnswerer === null) {
        return c.json({ error: "not_waiting" }, 409);
      }

      const outcome = await questionAnswerer.answer({
        paneId,
        sessionId: source.sessionId,
        blocked: pane.agentStatus === "blocked",
        request,
      });
      return outcome.ok ? c.json({ ok: true }) : c.json({ error: outcome.error }, outcome.status);
    },
    // 実行中の Claude のモデルと effort を、`/model` と `/effort` で切り替える
    // （docs/adr/claude-integration.md）。Claude だけ。
    switchModel: async (c: IdContext) => {
      const request = parseModelSwitchRequest(await c.req.json().catch(() => null));
      if (request === null) return c.json({ error: "invalid_request" }, 400);

      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId, pane } = resolved;
      if (pane.agent !== "claude") return c.json({ error: "not_claude" }, 400);

      // セッションの在り処はクライアントから受け取らず、BFF がペイン id から引く。
      const source = store.chatSource(paneId);
      if (!pane.chat || source?.agent !== "claude" || modelSwitcher === null) {
        return c.json({ error: "not_available" }, 409);
      }

      let directory: string;
      try {
        directory = await panes.directory({ paneId });
      } catch (error) {
        return paneFailure(c, error);
      }

      const outcome = await modelSwitcher.switch({
        paneId,
        sessionId: source.sessionId,
        directory,
        idle: pane.agentStatus === "idle" || pane.agentStatus === "done",
        blocked: () => {
          const state = store.get();
          return (state && findPane(state, paneId)?.agentStatus) === "blocked";
        },
        request,
      });
      return outcome.ok ? c.json({ ok: true }) : c.json({ error: outcome.error }, outcome.status);
    },
    defaultModel: async (c: IdContext) => {
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId, pane } = resolved;
      // 既定モデルは pi の起動直後だけに意味がある。シェルや他のエージェントには出さない。
      if (pane.agent !== "pi" || !pane.chat) return c.json({ model: null, effort: null });

      let directory: string;
      try {
        directory = await panes.directory({ paneId });
      } catch (error) {
        return paneFailure(c, error);
      }
      // 表示だけの補い。読めなくても会話は止めず、何も出さない。
      c.header("cache-control", "no-store");
      try {
        return c.json((await piDefaults.read(paneId, directory)) ?? { model: null, effort: null });
      } catch {
        return c.json({ error: "default_model_unavailable" }, 502);
      }
    },
    launchModel: async (c: IdContext) => {
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId, pane } = resolved;

      // 会話が読めるまでの表示だけに使う。シェルや、hwc 以外から起動したペインは空。
      c.header("cache-control", "no-store");
      if (pane.agent === null) return c.json({ model: null, effort: null });
      return c.json(launchModels.read(paneId) ?? { model: null, effort: null });
    },
    activity: async (c: IdContext) => {
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId, pane } = resolved;

      // 使い捨ての値。null を返すときも、ブラウザや中間に残さない。
      c.header("cache-control", "no-store");
      // 段階は会話の読み取りから導く。path はペイン id から引き、クライアントへは渡さない。
      // pi はセッションの隣の sidecar、Claude は transcript の進行行から読む（docs/adr/pi-integration.md / docs/adr/claude-integration.md）。
      const source = store.chatSource(paneId);
      if (!pane.chat || source === null) return c.json({ activity: null, session: null });
      if (source.agent === "pi") {
        return c.json({ activity: await readActivity(source.path), session: null });
      }
      // クライアントは保持中の値と session を比べ、変わっていれば捨てる。会話の id は渡すが、
      // path は渡さない。
      const session = source.sessionId;
      if (source.agent !== "claude" || claude?.activity === undefined) {
        return c.json({ activity: null, session });
      }
      // 段階は Herdr が working の間だけ返す。rewind の直後は idle なので、旧枝の未完了は出ない。
      if (pane.agentStatus !== "working") return c.json({ activity: null, session });
      try {
        const derived = await claude.activity(session);
        // ターンの最初の取得で、新しい prompt がまだ書かれていない間は出さない。
        const claimed = derived.prompt !== null && store.claimTurn(paneId, derived.prompt);
        return c.json({ activity: claimed ? derived.activity : null, session });
      } catch {
        return c.json({ activity: null, session });
      }
    },
    projects: async (c: IdContext) => {
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId, pane } = resolved;
      if (!pane.chat) return c.json({ error: "no_chat" }, 404);

      let cwd: string;
      try {
        cwd = await panes.directory({ paneId });
      } catch (error) {
        return paneFailure(c, error);
      }

      // マニフェストの追加を 30 秒まで待たせないよう、ブラウザ側にも残さない。
      c.header("cache-control", "no-store");
      try {
        return c.json(await projects.list({ cwd }));
      } catch {
        return c.json({ error: "projects_unavailable" }, 502);
      }
    },
  };
}
