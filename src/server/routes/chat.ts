import { readActivity } from "../chat/activity";
import { OpencodeServiceNotRunningError } from "../chat/opencode";
import { findPane } from "../herdr/state";
import { attachMessageFiles } from "../message-files";
import { isAgentModel, supportsModelSelection } from "../../shared/agents";
import type { AppContext, IdContext } from "./context";

export function createChatHandlers(ctx: AppContext) {
  const {
    store,
    panes,
    chat,
    opencode,
    codex,
    models,
    projects,
    previewRoots,
    current,
    launchModels,
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

      const client = { pi: chat, opencode, codex }[source.agent];
      if (client === undefined) return c.json({ error: "chat_unavailable" }, 502);

      try {
        const snapshot = launchModels.apply(
          paneId,
          await client.snapshot(source.agent === "pi" ? source.path : source.sessionId),
        );
        // 本文が指しているファイルを足す。中身が変わると etag も変わり、次の取得で新しい URL になる。
        const withFiles = await attachMessageFiles(
          snapshot,
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
    activity: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

      // 使い捨ての値。null を返すときも、ブラウザや中間に残さない。
      c.header("cache-control", "no-store");
      // 段階は pi 拡張がセッションの隣に書く。会話と同じく、path はペイン id から引く。
      const source = store.chatSource(paneId);
      if (!pane.chat || source === null || source.agent !== "pi") {
        return c.json({ activity: null });
      }
      return c.json({ activity: await readActivity(source.path) });
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
