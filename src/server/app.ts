import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import {
  attachmentContentType,
  attachmentExtOf,
  composeInputText,
  isAttachmentName,
  MAX_ATTACHMENT_BYTES,
} from "../shared/attachments";
import {
  attachmentExists,
  attachmentFilePath,
  defaultAttachmentsRoot,
  readAttachment,
  saveAttachment,
} from "./attachments";
import type { SessionChatClient } from "./chat/contract";
import { readActivity } from "./chat/activity";
import { OpencodeServiceNotRunningError } from "./chat/opencode";
import { createPane } from "./create-pane";
import { createWorktree } from "./create-worktree";
import { createPaneCloser } from "./close-pane";
import { createFolderTrust } from "./folder-trust";
import { createLaunchModels } from "./launch-models";
import type { PaneCloseAction } from "../shared/pane-close";
import {
  exceedsTextLimit,
  isInvalidRequest,
  isPaneNotFound,
  type PaneClient,
  parseInputBody,
  parseOutputQuery,
  parseSplitBody,
  TEXT_TOO_LONG,
  TEXT_WITH_ATTACHMENTS_TOO_LONG,
} from "./herdr/panes";
import type { AppState, PaneState, StateStore, TabState } from "./herdr/state";
import { parseMoveWorkspacesBody, type WorkspaceClient } from "./herdr/workspaces";
import type { WorktreeClient } from "./herdr/worktrees";
import type { PullRequestReader } from "./pull-request";
import type { GitClient } from "./git";
import {
  attachMessageFiles,
  defaultPreviewRoots,
  messageFileContentType,
  readMessageFile,
  resolveMessageFile,
  resolvePreviewFile,
} from "./message-files";
import { isHtmlName } from "../shared/message-files";
import { MAX_PANES_PER_TAB } from "../shared/panes";
import { isAgentModel, supportsFolderTrust, supportsModelSelection } from "../shared/agents";
import type { AgentModelsClient } from "./agent-models";
import { HerdrError } from "./herdr/socket";

// Bun.serve は 10 秒間何も書かれない chunked 応答を打ち切る。状態が変わらない間も接続を
// 保つため、これより短い間隔でハートビートを送る。
export const SSE_HEARTBEAT_MS = 5_000;

// 状態を変える JSON POST は simple request で叩かれないようにする。
// CORS を返さないので、cross-origin は preflight で止まる。body はここでは読まない。
const requireJson = createMiddleware(async (c, next) => {
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return c.json({ error: "content-type must be application/json" }, 415);
  }
  await next();
});

const PREVIEW_CSP = "sandbox allow-scripts";

// HTML はアプリと同じオリジンで配信する。モックの script から BFF を触れないよう、
// sandbox で文書のオリジンを不透明にする。iframe の属性だけに頼らず、直接開いた
// ときにも効くよう応答にも付ける（ADR 0051）。
function previewHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    // 書き直した HTML をそのまま見たい。版を URL に入れないのでキャッシュさせない。
    "cache-control": "no-store",
    // 不透明なオリジンからの ES modules と fetch は CORS になる。このルートだけ開ける。
    "access-control-allow-origin": "*",
    "content-security-policy": PREVIEW_CSP,
  };
}

// 書き出し直しや削除でファイルが消えても、iframe に生の JSON を出さない。
const PREVIEW_MISSING = `<!doctype html><meta charset="utf-8"><title>ファイルが見つかりません</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:14px/1.6 system-ui;color:#5b6068;background:#fff">
<p>ファイルが見つかりません。書き出し直してから再読み込みしてください。</p>`;

function previewNotFound(c: Context, requested: string): Response {
  if (!isHtmlName(requested)) return c.json({ error: "not_found" }, 404);
  return new Response(PREVIEW_MISSING, {
    status: 404,
    headers: previewHeaders("text/html; charset=utf-8"),
  });
}

export function createApp(options: {
  store: StateStore;
  panes: PaneClient;
  worktrees: WorktreeClient;
  workspaces: WorkspaceClient;
  chat: SessionChatClient;
  // opencode はローカルサービスの API から読む。サービスを読めない構成でも、ペインの
  // 一覧や端末出力は使えるようにする。
  opencode?: SessionChatClient;
  codex?: SessionChatClient;
  models?: AgentModelsClient;
  // PR は gh の起動を伴うので、状態の取得経路には載せない。求めたときだけ引く。
  pullRequests?: PullRequestReader;
  // fetch / pull は状態を変えるので、状態の取得とは別の口から呼ぶ。
  git?: GitClient;
  revision?: string;
  sseHeartbeatMs?: number;
  // 保存先はテストが実ホームへ書かないよう、外から差し替えられるようにする。
  attachmentsRoot?: string;
  // HTML のプレビューで読んでよい追加の根（チェックアウトの外）。
  previewRoots?: string[];
}) {
  const {
    store,
    panes,
    worktrees,
    workspaces,
    chat,
    opencode,
    codex,
    models,
    pullRequests,
    git,
    revision = "dev",
    sseHeartbeatMs = SSE_HEARTBEAT_MS,
    attachmentsRoot = defaultAttachmentsRoot(),
    previewRoots = defaultPreviewRoots(),
  } = options;

  const current = async (): Promise<AppState | null> =>
    store.get() ??
    store.refresh().catch(() => {
      // 取得に失敗した時点で状態は無い。呼び出し側がエラーを返す。
      return null;
    });

  const folderTrust = createFolderTrust(panes);
  const launchModels = createLaunchModels();

  const paneFailure = (c: Context, error: unknown) => {
    if (isPaneNotFound(error)) return c.json({ error: "pane_not_found" }, 404);
    if (isInvalidRequest(error)) return c.json({ error: "invalid_request" }, 400);
    return c.json({ error: "herdr_unavailable" }, 502);
  };

  // 作成できたか・再試行できるかで分ける。ソケットの期限切れ・切断・応答 parser の失敗は
  // 作成結果が不明なので herdr_unavailable へ畳み、クライアントに再送させない。
  const worktreeFailure = (c: Context, error: unknown) => {
    if (error instanceof HerdrError) {
      switch (error.code) {
        case "worktree_create_failed":
        case "worktree_open_failed":
          return c.json({ error: error.code }, 502);
        case "worktree_operation_in_progress":
        case "linked_worktree_source":
        case "not_git_worktree":
          return c.json({ error: error.code }, 409);
        case "workspace_not_found":
          return c.json({ error: "workspace_not_found" }, 404);
        case "invalid_params":
        case "invalid_request":
          return c.json({ error: "invalid_request" }, 400);
      }
    }
    return c.json({ error: "herdr_unavailable" }, 502);
  };

  const workspaceFailure = (c: Context, error: unknown) => {
    if (error instanceof HerdrError) {
      if (error.code === "workspace_not_found") {
        return c.json({ error: "workspace_not_found" }, 404);
      }
      if (error.code === "invalid_params" || error.code === "invalid_request") {
        return c.json({ error: "invalid_request" }, 400);
      }
    }
    return c.json({ error: "herdr_unavailable" }, 502);
  };

  const closePane = createPaneCloser(store, panes);
  const requestClose = async (c: Context, action: PaneCloseAction) => {
    const paneId = c.req.param("id") ?? "";
    try {
      const result = await closePane(paneId, action);
      if (result === "missing") return c.json({ error: "pane_not_found" }, 404);
      if (result === "changed") return c.json({ error: "pane_action_changed" }, 409);
      launchModels.forget(paneId);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_exit_unsafe") {
        return c.json({ error: error.code }, 409);
      }
      return paneFailure(c, error);
    }
  };

  const findPaneTab = (state: AppState, paneId: string): TabState | null => {
    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) {
        if (tab.panes.some((pane) => pane.id === paneId)) return tab;
      }
    }
    return null;
  };

  const findPane = (state: AppState, paneId: string): PaneState | null =>
    findPaneTab(state, paneId)?.panes.find((pane) => pane.id === paneId) ?? null;

  // If-None-Match は弱比較。W/ と引用符を落として比べ、複数値と * も受ける。
  const matchesEtag = (header: string | undefined, etag: string): boolean => {
    if (header === undefined) return false;
    return header.split(",").some((value) => {
      const trimmed = value.trim();
      if (trimmed === "*") return true;
      const unquoted = (trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed).replace(
        /^"|"$/g,
        "",
      );
      return unquoted === etag;
    });
  };

  // 画像は 1 枚の生バイトで受ける。保存名はサーバが決め、上書きしない。
  const uploadAttachment = async (c: Context) => {
    // 415 は body を読む前に返す。text/plain のような simple request は preflight を
    // 通らないので、Content-Type の allowlist だけで守る。
    const ext = attachmentExtOf(c.req.header("content-type"));
    if (ext === null) return c.json({ error: "unsupported_media_type" }, 415);

    const state = await current();
    if (!state) return c.json({ error: "herdr_unavailable" }, 502);

    const paneId = c.req.param("id") ?? "";
    const pane = findPane(state, paneId);
    if (!pane) return c.json({ error: "pane_not_found" }, 404);
    if (!pane.chat) return c.json({ error: "no_chat" }, 404);

    // 宣言された長さで先に落とし、読み終えた実バイト数でも見る。
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: "attachment_too_large" }, 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: "attachment_too_large" }, 413);
    }
    if (bytes.byteLength === 0) return c.json({ error: "invalid_request" }, 400);

    const name = await saveAttachment({ root: attachmentsRoot, paneId, ext, bytes });
    if (name === null) return c.json({ error: "invalid_request" }, 400);
    return c.json({ name });
  };

  // 保存した画像を返す。名前は固定書式だけを通してからパスへ連結する。
  const serveAttachment = async (c: Context) => {
    const state = await current();
    if (!state) return c.json({ error: "herdr_unavailable" }, 502);

    const paneId = c.req.param("id") ?? "";
    const pane = findPane(state, paneId);
    if (!pane) return c.json({ error: "pane_not_found" }, 404);
    if (!pane.chat) return c.json({ error: "no_chat" }, 404);

    const name = c.req.param("name") ?? "";
    if (!isAttachmentName(name)) return c.json({ error: "invalid_request" }, 400);
    const bytes = await readAttachment({ root: attachmentsRoot, paneId, name });
    if (bytes === null) return c.json({ error: "not_found" }, 404);

    // 保存した名前から決めた型で返し、中身を見て解釈させない。内容は変わらないので
    // 長く持たせる。認証が無い LAN 公開なので private にする。
    return new Response(bytes, {
      headers: {
        "content-type": attachmentContentType(name) ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  };

  return (
    new Hono()
      .get("/api/health", (c) => c.json({ ok: true, service: "hwc", revision }))
      .get("/api/panes/:id/models", async (c) => {
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
      })
      .get("/api/panes/:id/efforts", async (c) => {
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
      })
      .get("/api/state", async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);
        return c.json(state);
      })
      .get("/api/events", (c) =>
        streamSSE(c, async (stream) => {
          const write = (event: string | null, data: string) =>
            stream.writeSSE(event ? { event, data } : { data }).catch(() => {
              // 切断済みのクライアントへの書き込みは失敗する。購読解除は切断の検出側で行う。
            });
          const send = (state: AppState) => write(null, JSON.stringify(state));

          // 初期状態の送信中に届いた更新を取りこぼさないよう、購読を先に張って溜めておく。
          let ready = false;
          let buffered: AppState | null = null;
          const unsubscribe = store.onChange((state) => {
            if (ready) send(state);
            else buffered = state;
          });

          // 初期取得の間に届いた更新があればそれが最新なので、初回状態として使う。
          const initial = (await current()) ?? buffered;

          // 状態が無くてもストリームは開いたままにする。ここで 502 を返すと EventSource は
          // 接続失敗として扱い、以後再接続しない（Herdr 復帰後も画面が止まる）。
          if (initial) await send(initial);
          else await write("unavailable", "");
          ready = true;
          if (buffered && buffered !== initial) await send(buffered);

          // ハンドラが返るとストリームが閉じるので、切断されるまで待つ。
          await new Promise<void>((resolve) => {
            // 状態の変化が無い間も書き続ける。無名イベントのコメント行は EventSource が
            // 読み飛ばすので、状態を受ける onmessage は反応しない。
            const heartbeat = setInterval(() => {
              void stream.write(": ping\n\n");
            }, sseHeartbeatMs);

            const detach = () => {
              clearInterval(heartbeat);
              unsubscribe();
              resolve();
            };
            if (stream.aborted) {
              detach();
              return;
            }
            stream.onAbort(detach);
          });
        }),
      )
      .get("/api/workspaces/:id/pull-request", async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);
        const workspace = state.workspaces.find((item) => item.id === c.req.param("id"));
        if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);

        // チップを出さないだけで足りるので、引けない場合は「PR が無い」と同じ応答にする。
        // gh の失敗や期限切れで画面を止めない。概要は merge 後も出すため、最新の PR を
        // 状態不問で返し、チップを出すかはクライアントが state で決める。
        c.header("cache-control", "no-store");
        const branch = workspace.branch ?? null;
        const checkoutPath = store.workspacePath(workspace.id);
        if (branch === null || checkoutPath === null || pullRequests === undefined) {
          return c.json({ pullRequest: null });
        }
        const refresh = c.req.query("refresh") === "1";
        const pullRequest = await pullRequests({ checkoutPath, branch, refresh }).catch(() => null);
        return c.json({ pullRequest });
      })
      .post("/api/workspaces/:id/git", requireJson, async (c) => {
        const body = await c.req.json().catch(() => null);
        const action =
          typeof body === "object" && body !== null
            ? (body as { action?: unknown }).action
            : undefined;
        if (action !== "fetch" && action !== "pull") {
          return c.json({ error: "invalid_request" }, 400);
        }

        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const workspaceId = c.req.param("id");
        const workspace = state.workspaces.find((item) => item.id === workspaceId);
        if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);

        const checkoutPath = store.workspacePath(workspace.id);
        if (checkoutPath === null) return c.json({ error: "not_git_worktree" }, 409);
        // ブランチが読めない場所は git のワークツリーではない。detached HEAD もここに入る。
        if (workspace.branch == null) return c.json({ error: "not_git_worktree" }, 409);
        if (git === undefined) return c.json({ error: "git_unavailable" }, 502);
        // 状態が古い場合も、クライアントが同じ条件で出し分けている。ここでは最後の砦。
        if (workspace.sync?.hasRemote !== true) {
          return c.json({ error: "no_remote" }, 409);
        }
        if (action === "pull" && workspace.sync?.upstream == null) {
          return c.json({ error: "no_upstream" }, 409);
        }

        try {
          if (action === "fetch") await git.fetch(checkoutPath);
          else await git.pull(checkoutPath);
        } catch {
          return c.json(
            { error: action === "fetch" ? "git_fetch_failed" : "git_pull_failed" },
            502,
          );
        }

        // 次の状態公開で上流との差を読み直す。取得に失敗しても git の操作自体は終わっている。
        store.invalidateGit(workspace.id);
        await store.refresh().catch(() => {});
        return c.json({ ok: true });
      })
      .post("/api/workspaces/move", requireJson, async (c) => {
        const body = await c.req.json().catch(() => null);
        const parsed = parseMoveWorkspacesBody(body);
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);

        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        // 状態に無い id は、クライアントと BFF の取り違え。Herdr に渡す前に止める。
        const known = new Set(state.workspaces.map((workspace) => workspace.id));
        if (!parsed.value.workspaceIds.every((id) => known.has(id))) {
          return c.json({ error: "workspace_not_found" }, 404);
        }
        const before = parsed.value.beforeWorkspaceId;
        if (before !== null && !known.has(before)) {
          return c.json({ error: "workspace_not_found" }, 404);
        }

        try {
          await workspaces.moveBlock(parsed.value);
        } catch (error) {
          return workspaceFailure(c, error);
        }

        // イベントでも取り直すが、応答と SSE の前後で古い順に戻って見えるのを避ける。
        await store.refresh().catch(() => {});
        return c.json({ ok: true });
      })
      .get("/api/panes/:id/chat", async (c) => {
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
      })
      .get("/api/panes/:id/activity", async (c) => {
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
      })
      .post("/api/panes/:id/attachments", uploadAttachment)
      .get("/api/panes/:id/attachments/:name", serveAttachment)
      // エージェントが本文で示した画像を返す。根はワークスペースのチェックアウトで、
      // realpath で解決した実体がその配下にあるときだけ返す。
      .get("/api/panes/:id/files", async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const paneId = c.req.param("id");
        const pane = findPane(state, paneId);
        if (!pane) return c.json({ error: "pane_not_found" }, 404);
        if (!pane.chat) return c.json({ error: "no_chat" }, 404);

        const root = store.workspaceRoot(paneId);
        if (root === null) return c.json({ error: "not_found" }, 404);

        const file = await resolveMessageFile({ root, path: c.req.query("path") ?? "" });
        if (file === null) return c.json({ error: "not_found" }, 404);
        const bytes = await readMessageFile(file);
        if (bytes === null) return c.json({ error: "not_found" }, 404);

        return new Response(bytes, {
          headers: {
            "content-type": messageFileContentType(file.name) ?? "application/octet-stream",
            "x-content-type-options": "nosniff",
            // 同じ名前で作り直されるので、名前だけでは長期に持たせられない。版が URL に
            // 入っているので、その URL の中では内容が変わらない。
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
      })
      // エージェントが書いた HTML と、そこから相対参照されるファイル。パス形式にして、
      // `<link href="./app.css">` のような参照をそのまま解決させる。先頭の番号は根の番号で、
      // 相対参照でも保たれる（同名ファイルが別の根にあっても取り違えない）。
      .get("/api/panes/:id/preview/:root/:path{.+}", async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const paneId = c.req.param("id");
        const pane = findPane(state, paneId);
        if (!pane) return c.json({ error: "pane_not_found" }, 404);
        if (!pane.chat) return c.json({ error: "no_chat" }, 404);

        const requested = c.req.param("path") ?? "";
        const rootIndex = Number(c.req.param("root"));
        if (!Number.isInteger(rootIndex) || rootIndex < 0) return previewNotFound(c, requested);

        const workspaceRoot = store.workspaceRoot(paneId);
        const roots = workspaceRoot === null ? previewRoots : [workspaceRoot, ...previewRoots];
        const root = roots[rootIndex];
        if (root === undefined) return previewNotFound(c, requested);

        const file = await resolvePreviewFile({ root, path: requested });
        const bytes = file === null ? null : await readMessageFile(file);
        if (file === null || bytes === null) return previewNotFound(c, requested);

        return new Response(bytes, { headers: previewHeaders(file.contentType) });
      })
      .get("/api/panes/:id/output", async (c) => {
        const query = parseOutputQuery(new URL(c.req.url).searchParams);
        if (!query.ok) return c.json({ error: query.error }, query.status);

        try {
          const state = await current();
          if (!state) return c.json({ error: "herdr_unavailable" }, 502);
          const paneId = c.req.param("id");
          const pane = findPane(state, paneId);
          if (!pane) return c.json({ error: "pane_not_found" }, 404);
          folderTrust.retain(
            state.workspaces.flatMap((workspace) =>
              workspace.tabs.flatMap((tab) => tab.panes.map((item) => item.id)),
            ),
          );
          const output = await panes.read({ paneId, ...query.value });
          const interaction = await folderTrust.inspect(pane);
          return c.json({ ...output, interaction });
        } catch (error) {
          return paneFailure(c, error);
        }
      })
      .post("/api/panes/:id/clear-output", requireJson, async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const paneId = c.req.param("id");
        if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);

        try {
          await panes.clear({ paneId });
          // 状態は変わらない。表示はクライアントが次の read で置き換える。
          return c.json({ ok: true });
        } catch (error) {
          return paneFailure(c, error);
        }
      })
      .post("/api/panes/:id/confirm-folder-trust", requireJson, async (c) => {
        const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
        if (typeof body?.id !== "string" || body.id.length === 0 || body.id.length > 128) {
          return c.json({ error: "invalid_request" }, 400);
        }
        try {
          const state = await store.refresh();
          const pane = findPane(state, c.req.param("id"));
          if (!pane) return c.json({ error: "pane_not_found" }, 404);
          const result = await folderTrust.accept(pane, body.id);
          if (result === "changed") return c.json({ error: "confirmation_changed" }, 409);
          return c.json({ ok: true });
        } catch (error) {
          return paneFailure(c, error);
        }
      })
      .post("/api/panes/:id/input", requireJson, async (c) => {
        // body は JSON として読み切ってから text のバイト数で上限を見る。Content-Type の検証で
        // browser の cross-origin は preflight に落ちるが、LAN の非 browser client はここまで
        // 到達し得る。その場合の巨大 body は Bun の body 読み込みに任せる。
        const body = await c.req.json().catch(() => null);
        const input = parseInputBody(body);
        if (!input.ok) return c.json({ error: input.error }, input.status);

        const paneId = c.req.param("id");
        const paths: string[] = [];
        const state = await current();
        const pane = state === null ? null : findPane(state, paneId);
        if (pane !== null && supportsFolderTrust(pane.agent)) {
          try {
            if (await folderTrust.inspect(pane))
              return c.json({ error: "confirmation_pending" }, 409);
          } catch (error) {
            return paneFailure(c, error);
          }
        }
        // 添付が無いときは Herdr の pane_not_found に任せる。ペインの実在を状態から引くと、
        // 従来の経路に余分な往復が増える。
        if (input.value.attachments.length > 0) {
          const state = await current();
          if (!state) return c.json({ error: "herdr_unavailable" }, 502);

          const pane = findPane(state, paneId);
          if (!pane) return c.json({ error: "pane_not_found" }, 404);
          if (!pane.chat) return c.json({ error: "no_chat" }, 404);

          // 書式は parseInputBody が見ている。ここではこのペインの保存先の実在を確かめる。
          for (const name of input.value.attachments) {
            const path = attachmentFilePath(attachmentsRoot, paneId, name);
            if (path === null || !(await attachmentExists(attachmentsRoot, paneId, name))) {
              return c.json({ error: "invalid_request" }, 400);
            }
            paths.push(path);
          }
        }

        // 上限は注記を組み立てた後の本文で測る。パスの分だけ書ける量が減る。
        const text = composeInputText(input.value.text, paths);
        if (exceedsTextLimit(text)) {
          return c.json(
            { error: paths.length === 0 ? TEXT_TOO_LONG : TEXT_WITH_ATTACHMENTS_TOO_LONG },
            413,
          );
        }

        try {
          await panes.send({ paneId, text, submit: input.value.submit });
          return c.json({ ok: true });
        } catch (error) {
          return paneFailure(c, error);
        }
      })
      .get("/api/panes/:id/process", async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const paneId = c.req.param("id");
        if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);

        try {
          return c.json({ process: await panes.process({ paneId }) });
        } catch (error) {
          return paneFailure(c, error);
        }
      })
      .post("/api/panes/:id/stop", requireJson, async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const paneId = c.req.param("id");
        const pane = findPane(state, paneId);
        if (!pane) return c.json({ error: "pane_not_found" }, 404);

        // シェルは前景プロセスを C-c で止める。プロンプトへの C-c は入力中の行を消すだけなので、
        // 何か動いているときだけ送る。画面が古いだけの再クリックは成功として扱う。
        if (pane.agent === null) {
          try {
            if ((await panes.process({ paneId })).running) await panes.interrupt({ paneId });
            return c.json({ ok: true });
          } catch (error) {
            return paneFailure(c, error);
          }
        }

        // 止まっているペインに Esc を送ると、入力欄やダイアログを閉じてしまう。
        // 画面が古いだけの再クリックは成功として扱い、状態の反映はイベントに任せる。
        if (pane.agentStatus !== "working") return c.json({ ok: true });

        try {
          if (supportsFolderTrust(pane.agent) && (await folderTrust.inspect(pane))) {
            return c.json({ error: "confirmation_pending" }, 409);
          }
          await panes.stop({ paneId });
          return c.json({ ok: true });
        } catch (error) {
          return paneFailure(c, error);
        }
      })
      .post("/api/panes/:id/focus", requireJson, async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const paneId = c.req.param("id");
        if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);

        try {
          await panes.focus({ paneId });
          // 状態の取り直しは Herdr のイベント（pane.focused / pane.agent_status_changed）に任せる。
          // ここで refresh を待つと、成功した focus が再取得の失敗で 502 になる。
          return c.json({ ok: true });
        } catch (error) {
          return paneFailure(c, error);
        }
      })
      .post("/api/panes/:id/close", requireJson, (c) => requestClose(c, "close"))
      .post("/api/panes/:id/exit", requireJson, (c) => requestClose(c, "exit"))
      .post("/api/panes/:id/split", requireJson, async (c) => {
        // 追加の指定（名前・起動するエージェント）は body から読む。body 無しは不正。
        const body = await c.req.json().catch(() => null);
        const request = parseSplitBody(body);
        if (!request.ok) return c.json({ error: request.error }, request.status);

        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const paneId = c.req.param("id");
        const tab = findPaneTab(state, paneId);
        if (tab === null) return c.json({ error: "pane_not_found" }, 404);
        // 画面が古い・同時に押された場合の取りこぼしを、Herdr を呼ぶ前に止める。
        if (tab.panes.length >= MAX_PANES_PER_TAB) return c.json({ error: "pane_limit" }, 409);

        try {
          const result = await createPane(panes, paneId, request.value, models);
          // 名前の付け直しに失敗してもエージェントは起動している。起動できた場合だけ、
          // 選んだモデルを会話に載るまでの表示に使う。
          if ((result.ok || result.error === "pane_rename_failed") && request.value.model != null) {
            launchModels.remember(result.paneId, request.value.model, request.value.effort ?? null);
          }
          if (!result.ok) {
            if (result.error === "pane_limit") return c.json({ error: result.error }, 409);
            return c.json({ error: result.error, paneId: result.paneId }, 502);
          }

          // focus / close と同じく、状態の取り直しは Herdr のイベント（pane.created）に任せる。
          return c.json({ paneId: result.paneId });
        } catch (error) {
          return paneFailure(c, error);
        }
      })
      .post("/api/workspaces/:id/create-worktree", requireJson, async (c) => {
        // 作成後のエージェント起動まで同じ指定を使う。body 無しは不正。
        const body = await c.req.json().catch(() => null);
        const request = parseSplitBody(body);
        if (!request.ok) return c.json({ error: request.error }, request.status);

        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const workspaceId = c.req.param("id");
        const workspace = state.workspaces.find((item) => item.id === workspaceId);
        if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);
        // 起点はリポジトリ本体に限る。worktree 情報が無いスペースも Herdr が拒否する。
        if (workspace.worktree === null) return c.json({ error: "not_git_worktree" }, 409);
        if (workspace.worktree.isLinkedWorktree) {
          return c.json({ error: "linked_worktree_source" }, 409);
        }

        try {
          const result = await createWorktree(worktrees, panes, workspaceId, request.value, models);
          // 分割 API と同じく、名前の付け直しに失敗してもエージェントは起動している。
          if ((result.ok || result.error === "pane_rename_failed") && request.value.model != null) {
            launchModels.remember(result.paneId, request.value.model, request.value.effort ?? null);
          }
          if (!result.ok) {
            // ワークツリーと root シェルは残っている。クライアントは理由を見せて閉じるだけにする。
            return c.json(
              { error: result.error, workspaceId: result.workspaceId, paneId: result.paneId },
              502,
            );
          }
          // 状態の取り直しは Herdr のイベント（workspace.created / pane.created）に任せる。
          return c.json({ workspaceId: result.workspaceId, paneId: result.paneId });
        } catch (error) {
          return worktreeFailure(c, error);
        }
      })
      .post("/api/workspaces/:id/remove-worktree", requireJson, async (c) => {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const workspaceId = c.req.param("id");
        const workspace = state.workspaces.find((item) => item.id === workspaceId);
        if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);
        // worktree.remove は linked worktree 専用。本体（linked でない）は Herdr も拒否する。
        if (workspace.worktree?.isLinkedWorktree !== true) {
          return c.json({ error: "not_linked_worktree" }, 409);
        }

        try {
          await worktrees.remove({ workspaceId });
          // スペースが消えるのは Herdr のイベント（workspace.closed）に任せる。
          return c.json({ ok: true });
        } catch (error) {
          if (error instanceof HerdrError) {
            if (error.code === "not_linked_worktree") {
              return c.json({ error: error.code }, 409);
            }
            if (error.code === "workspace_not_found" || error.code === "worktree_not_found") {
              return c.json({ error: "workspace_not_found" }, 404);
            }
          }
          return c.json({ error: "herdr_unavailable" }, 502);
        }
      })
  );
}

export type AppType = ReturnType<typeof createApp>;
