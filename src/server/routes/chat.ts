import { attachAttachmentSizes } from "../attachments";
import { readActivity } from "../chat/activity";
import { OpencodeServiceNotRunningError } from "../chat/opencode";
import { findPane } from "../herdr/state";
import { attachMessageFiles } from "../message-files";
import { isAgentModel, supportsModelSelection } from "../../shared/agents";
import { parseAnswerRequest } from "../../shared/answer";
import type { AppContext, IdContext } from "./context";

export function createChatHandlers(ctx: AppContext) {
  const {
    store,
    panes,
    chat,
    opencode,
    codex,
    claude,
    models,
    projects,
    previewRoots,
    attachmentsRoot,
    current,
    launchModels,
    piDefaults,
    questionAnswerer,
    paneFailure,
    matchesEtag,
  } = ctx;

  return {
    models: async (c: IdContext) => {
      const agent = c.req.query("agent");
      if (!supportsModelSelection(agent)) return c.json({ error: "invalid_request" }, 400);
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);
      const paneId = c.req.param("id");
      if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);
      try {
        if (!models) return c.json({ error: "models_unavailable" }, 502);
        const directory = await panes.directory({ paneId });
        return c.json({ models: await models.list(agent, directory) });
      } catch (error) {
        if (agent === "opencode" && error instanceof OpencodeServiceNotRunningError)
          return c.json({ error: "opencode_not_running" }, 502);
        return c.json({ error: "models_unavailable" }, 502);
      }
    },
    efforts: async (c: IdContext) => {
      const agent = c.req.query("agent");
      const model = { provider: c.req.query("provider"), id: c.req.query("model") };
      if (!supportsModelSelection(agent) || !isAgentModel(model))
        return c.json({ error: "invalid_request" }, 400);
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);
      const paneId = c.req.param("id");
      if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);
      try {
        if (!models) return c.json({ error: "efforts_unavailable" }, 502);
        const directory = await panes.directory({ paneId });
        return c.json({ efforts: await models.efforts(agent, model, directory) });
      } catch {
        return c.json({ error: "efforts_unavailable" }, 502);
      }
    },
    chat: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

      // セッションの在り処はクライアントから受け取らず、BFF がペイン id から引く。
      const source = store.chatSource(paneId);
      if (!pane.chat || source === null) return c.json({ error: "no_chat" }, 404);

      const client = { pi: chat, opencode, codex, claude }[source.agent];
      if (client === undefined) return c.json({ error: "chat_unavailable" }, 502);

      try {
        const live = await client.snapshot(source.agent === "pi" ? source.path : source.sessionId);
        // 解決済みの既定は捨てる。預かりは残すので、/new の後は読み直せる（ADR 0091）。
        piDefaults.dropResolved(paneId, live.model);
        const snapshot = launchModels.apply(paneId, live);
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
    // AskUserQuestion に Esc で閉じて本文で答える（ADR 0099）。Claude だけ。
    answerQuestion: async (c: IdContext) => {
      const request = parseAnswerRequest(await c.req.json().catch(() => null));
      if (request === null) return c.json({ error: "invalid_request" }, 400);

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);
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
    defaultModel: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);
      // 既定モデルは pi の起動直後だけに意味がある。シェルや他のエージェントには出さない。
      if (pane.agent !== "pi" || !pane.chat) return c.json({ model: null, effort: null });

      let directory: string;
      try {
        directory = await panes.directory({ paneId });
      } catch (error) {
        return paneFailure(c, error);
      }
      // 表示だけの補い。読めなくても会話は止めず、何も出さない（ADR 0087）。
      c.header("cache-control", "no-store");
      try {
        return c.json((await piDefaults.read(paneId, directory)) ?? { model: null, effort: null });
      } catch {
        return c.json({ error: "default_model_unavailable" }, 502);
      }
    },
    activity: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

      // 使い捨ての値。null を返すときも、ブラウザや中間に残さない。
      c.header("cache-control", "no-store");
      // 段階は会話の読み取りから導く。path はペイン id から引き、クライアントへは渡さない。
      // pi はセッションの隣の sidecar、Claude は transcript の進行行から読む（ADR 0035 / 0100）。
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
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);
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
