import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { createAppContext, type CreateAppOptions } from "./routes/context";
import { createChatHandlers } from "./routes/chat";
import { createFilesHandlers } from "./routes/files";
import { createNotificationsHandlers } from "./routes/notifications";
import { createPanesHandlers } from "./routes/panes";
import { createRestartHandlers } from "./routes/restart";
import { createStateHandlers } from "./routes/state";
import { createWorkspacesHandlers } from "./routes/workspaces";

export { RESTART_DELAY_MS, SSE_HEARTBEAT_MS } from "./routes/context";

// 状態を変える JSON POST は simple request で叩かれないようにする。
// CORS を返さないので、cross-origin は preflight で止まる。body はここでは読まない。
const requireJson = createMiddleware(async (c, next) => {
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return c.json({ error: "content-type must be application/json" }, 415);
  }
  await next();
});

export function createApp(options: CreateAppOptions) {
  const ctx = createAppContext(options);
  const chatHandlers = createChatHandlers(ctx);
  const filesHandlers = createFilesHandlers(ctx);
  const notificationsHandlers = createNotificationsHandlers(ctx);
  const panesHandlers = createPanesHandlers(ctx);
  const restartHandlers = createRestartHandlers(ctx);
  const stateHandlers = createStateHandlers(ctx);
  const workspacesHandlers = createWorkspacesHandlers(ctx);

  return (
    new Hono()
      .get("/api/health", stateHandlers.health)
      .get("/api/restart", restartHandlers.get)
      .put("/api/restart", requireJson, restartHandlers.put)
      // 応答を返してから起動する。実行できたかは起動前の判定までで、終了は待たない。
      .post("/api/restart", requireJson, restartHandlers.run)
      .get("/api/notifications", notificationsHandlers.get)
      .put("/api/notifications", requireJson, notificationsHandlers.put)
      .put("/api/notifications/discord", requireJson, notificationsHandlers.putDiscord)
      .delete("/api/notifications/discord", notificationsHandlers.deleteDiscord)
      .post("/api/notifications/discord/test", requireJson, notificationsHandlers.testDiscord)
      .get("/api/panes/:id/models", chatHandlers.models)
      .get("/api/panes/:id/efforts", chatHandlers.efforts)
      .get("/api/state", stateHandlers.state)
      .get("/api/events", stateHandlers.events)
      .get("/api/workspaces/:id/pull-request", workspacesHandlers.pullRequest)
      .post("/api/workspaces/:id/git", requireJson, workspacesHandlers.git)
      .post("/api/workspaces/move", requireJson, workspacesHandlers.move)
      .get("/api/panes/:id/chat", chatHandlers.chat)
      .get("/api/panes/:id/activity", chatHandlers.activity)
      // マニフェストがあるディレクトリを、ペインの cwd から下だけ列挙する。
      // 兄弟プロジェクトは、このペインから相対パスで届く範囲に無いものとして扱う。
      .get("/api/panes/:id/projects", chatHandlers.projects)
      .post("/api/panes/:id/attachments", filesHandlers.uploadAttachment)
      .get("/api/panes/:id/attachments/:name", filesHandlers.serveAttachment)
      // エージェントが本文で示した画像を返す。根はチェックアウトと追加根で、
      // realpath で解決した実体がその配下にあるときだけ返す。root は根の番号。
      .get("/api/panes/:id/files", filesHandlers.files)
      // エージェントが書いた HTML と、そこから相対参照されるファイル。パス形式にして、
      // `<link href="./app.css">` のような参照をそのまま解決させる。先頭の番号は根の番号で、
      // 相対参照でも保たれる（同名ファイルが別の根にあっても取り違えない）。
      .get("/api/panes/:id/preview/:root/:path{.+}", filesHandlers.preview)
      .get("/api/panes/:id/output", panesHandlers.output)
      .post("/api/panes/:id/clear-output", requireJson, panesHandlers.clearOutput)
      .post("/api/panes/:id/confirm-folder-trust", requireJson, panesHandlers.confirmFolderTrust)
      .post("/api/panes/:id/input", requireJson, panesHandlers.input)
      .get("/api/panes/:id/process", panesHandlers.process)
      .post("/api/panes/:id/stop", requireJson, panesHandlers.stop)
      .post("/api/panes/:id/focus", requireJson, panesHandlers.focus)
      .post("/api/panes/:id/close", requireJson, panesHandlers.close)
      .post("/api/panes/:id/exit", requireJson, panesHandlers.exit)
      .post("/api/panes/:id/split", requireJson, panesHandlers.split)
      .post("/api/panes/:id/agent", requireJson, panesHandlers.agent)
      .post("/api/workspaces/:id/create-worktree", requireJson, workspacesHandlers.createWorktree)
      .post("/api/workspaces/:id/remove-worktree", requireJson, workspacesHandlers.removeWorktree)
      .post("/api/workspaces/:id/close", requireJson, workspacesHandlers.close)
  );
}

export type AppType = ReturnType<typeof createApp>;
