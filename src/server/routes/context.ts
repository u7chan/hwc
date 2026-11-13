import type { Context, Env } from "hono";
import {
  attachmentContentType,
  attachmentKindOfName,
  decodeAttachmentName,
  FILENAME_HEADER,
  isImageAttachmentName,
  maxAttachmentBytes,
  sanitizeAttachmentName,
} from "../../shared/attachments";
import { defaultAttachmentsRoot, readAttachment, saveAttachment } from "../attachments";
import type { SessionChatClient } from "../chat/contract";
import { createPaneCloser } from "../close-pane";
import { createExitCleanup } from "../exit-cleanup";
import { createFolderTrust } from "../folder-trust";
import { createLaunchModels } from "../launch-models";
import type { PaneCloseAction } from "../../shared/pane-close";
import { isInvalidRequest, isPaneNotFound, type PaneClient } from "../herdr/panes";
import { type AppState, findPane, type StateStore, type TabState } from "../herdr/state";
import type { WorkspaceClient } from "../herdr/workspaces";
import type { WorktreeClient } from "../herdr/worktrees";
import type { PullRequestReader } from "../pull-request";
import {
  createDiscordSender,
  createNotificationSettingsStore,
  type DiscordSender,
  type NotificationSettingsStore,
} from "../notifications";
import {
  isNotificationScope,
  toNotificationView,
  type NotificationSettings,
} from "../../shared/notifications";
import { normalizeRestartCommand, type RestartSettings } from "../../shared/restart";
import type { GitClient } from "../git";
import { createProjectLister, type ProjectLister } from "../projects";
import {
  createRestartRunner,
  createRestartSettingsStore,
  type RestartRunner,
  type RestartSettingsStore,
} from "../restart";
import { defaultPreviewRoots } from "../message-files";
import type { AgentModelsClient } from "../agent-models";
import { HerdrError } from "../herdr/socket";

// Bun.serve は 10 秒間何も書かれない chunked 応答を打ち切る。状態が変わらない間も接続を
// 保つため、これより短い間隔でハートビートを送る。
export const SSE_HEARTBEAT_MS = 5_000;

// 再起動コマンドを起動するまでの猶予。応答の書き込みを終える前に走らせると、HWC 自身を
// 止めるコマンドの場合にその応答が落ちる。
export const RESTART_DELAY_MS = 100;

export type PlainContext = Context;
export type IdContext = Context<Env, "/:id">;
export type IdNameContext = Context<Env, "/:id/:name">;
export type PreviewContext = Context<Env, "/:id/:root/:path">;

export type AppContext = ReturnType<typeof createAppContext>;

export type CreateAppOptions = {
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
  // プロジェクト候補はペインの cwd を走査する。テストでは走査結果を差し替える。
  projects?: ProjectLister;
  revision?: string;
  sseHeartbeatMs?: number;
  // 保存先はテストが実ホームへ書かないよう、外から差し替えられるようにする。
  attachmentsRoot?: string;
  // エージェントが示したファイルを配信してよい追加の根（チェックアウトの外）。
  // 既定は /tmp と HWC_PREVIEW_ROOTS（ADR 0066）。
  previewRoots?: string[];
  // 通知設定の保存先と Webhook 送信器。テストでは実ファイル・実ネットワークを避けて差し替える。
  notificationSettings?: NotificationSettingsStore;
  discordSender?: DiscordSender;
  // 再起動コマンドの保存先と起動器。テストでは実プロセスを起動しないよう差し替える。
  restartSettings?: RestartSettingsStore;
  restart?: RestartRunner;
  restartDelayMs?: number;
};

export function createAppContext(options: CreateAppOptions) {
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
    projects = createProjectLister(),
    revision = "dev",
    sseHeartbeatMs = SSE_HEARTBEAT_MS,
    attachmentsRoot = defaultAttachmentsRoot(),
    previewRoots = defaultPreviewRoots(),
    notificationSettings = createNotificationSettingsStore({ read: () => null, write: () => {} }),
    discordSender = createDiscordSender(),
    restartSettings = createRestartSettingsStore({ read: () => null, write: () => {} }),
    restart = createRestartRunner(),
    restartDelayMs = RESTART_DELAY_MS,
  } = options;

  // 「今」は状態ではなく送信時に決める。状態に持たせると、キャッシュされた状態に古い時刻が
  // 残り、状態が動かない間は経過が止まって見える。クライアントはこの now で時計を合わせる。

  const stateMessage = (state: AppState) => ({ state, now: Date.now() });

  const current = async (): Promise<AppState | null> =>
    store.get() ??
    store.refresh().catch(() => {
      // 取得に失敗した時点で状態は無い。呼び出し側がエラーを返す。
      return null;
    });

  // 同じ場所の close 要求が同時に来ると、両方が重複チェックを通って最後の 1 つまで
  // 閉じ得る。BFF は 1 プロセスなので、閉じている間と、閉じた直後の状態が届くまでの
  // workspace id を覚えておき、後続の要求を 409 にする。
  const closingSpaces = new Map<string, Set<string>>();

  const releaseClosingSpace = (placeKey: string, workspaceId: string) => {
    const ids = closingSpaces.get(placeKey);
    if (ids === undefined) return;
    ids.delete(workspaceId);
    if (ids.size === 0) closingSpaces.delete(placeKey);
  };

  // 状態から消えた id はもう閉じている。次の close 要求でガードを外す。
  const pruneClosingSpaces = (state: AppState) => {
    const live = new Set(state.workspaces.map((workspace) => workspace.id));
    for (const [placeKey, ids] of closingSpaces) {
      for (const id of ids) {
        if (!live.has(id)) ids.delete(id);
      }
      if (ids.size === 0) closingSpaces.delete(placeKey);
    }
  };

  // 根の番号は /files と /preview で共通。片方だけ順を変えると、チップと配信が
  // 別の実体を指す。番号は 0 がチェックアウト、1 以上が追加根（無い場合は 0 から）。
  const rootsFor = (workspaceRoot: string | null): string[] =>
    workspaceRoot === null ? previewRoots : [workspaceRoot, ...previewRoots];

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

  // 重複スペースを閉じる操作は、フォルダを消さない。linked worktree の削除とは
  // エラーコードも入口も分ける。グループを閉じる要求は勝手に通さない。
  const closeSpaceFailure = (c: Context, error: unknown) => {
    if (error instanceof HerdrError) {
      if (error.code === "workspace_not_found") {
        return c.json({ error: "workspace_not_found" }, 404);
      }
      if (error.code === "workspace_group_close_required") {
        return c.json({ error: error.code }, 409);
      }
      if (error.code === "invalid_params" || error.code === "invalid_request") {
        return c.json({ error: "invalid_request" }, 400);
      }
    }
    return c.json({ error: "herdr_unavailable" }, 502);
  };

  const closePane = createPaneCloser(store, panes);
  const exitCleanup = createExitCleanup(store, panes);
  const requestClose = async (c: IdContext, action: PaneCloseAction) => {
    const paneId = c.req.param("id") ?? "";
    try {
      const result = await closePane(paneId, action);
      if (result === "missing") return c.json({ error: "pane_not_found" }, 404);
      if (result === "changed") return c.json({ error: "pane_action_changed" }, 409);
      launchModels.forget(paneId);
      // シェルに戻ったのを観測してから、終了したエージェントの画面を消す
      // （ADR 0073 clear-exited-agent-screen）。
      if (action === "exit") exitCleanup(paneId);
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
  const uploadAttachment = async (c: IdContext) => {
    // 種別と上限は元のファイル名の拡張子で決まる。body を読む前に名前を検査する。
    // ヘッダは ASCII しか運べないので、クライアントは percent-encode して送る。
    const decoded = decodeAttachmentName(c.req.header(FILENAME_HEADER));
    const name = decoded === null ? "" : sanitizeAttachmentName(decoded);
    if (name === "") return c.json({ error: "invalid_request" }, 400);
    const limit = maxAttachmentBytes(attachmentKindOfName(name));

    const state = await current();
    if (!state) return c.json({ error: "herdr_unavailable" }, 502);

    const paneId = c.req.param("id") ?? "";
    const pane = findPane(state, paneId);
    if (!pane) return c.json({ error: "pane_not_found" }, 404);
    if (!pane.chat) return c.json({ error: "no_chat" }, 404);

    // 宣言された長さで先に落とし、読み終えた実バイト数でも見る。
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      return c.json({ error: "attachment_too_large" }, 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > limit) {
      return c.json({ error: "attachment_too_large" }, 413);
    }
    if (bytes.byteLength === 0) return c.json({ error: "invalid_request" }, 400);

    const saved = await saveAttachment({ root: attachmentsRoot, paneId, name, bytes });
    if (saved === null) return c.json({ error: "invalid_request" }, 400);
    return c.json({ name: saved });
  };

  // 保存した画像を返す。配信するのは画像 3 形式だけで、名前の検証とは別に絞る。
  const serveAttachment = async (c: IdNameContext) => {
    const state = await current();
    if (!state) return c.json({ error: "herdr_unavailable" }, 502);

    const paneId = c.req.param("id") ?? "";
    const pane = findPane(state, paneId);
    if (!pane) return c.json({ error: "pane_not_found" }, 404);
    if (!pane.chat) return c.json({ error: "no_chat" }, 404);

    const name = c.req.param("name") ?? "";
    if (!isImageAttachmentName(name)) return c.json({ error: "invalid_request" }, 400);
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

  // 通知設定は 1 つのストアに集約する。トグル・scope・URL が同時に変わっても、
  // 書き込みが成功した設定だけを返し、クライアントは応答で丸ごと置き換える。
  const notificationView = () => toNotificationView(notificationSettings.get());

  const saveNotificationSettings = (c: Context, next: NotificationSettings) => {
    try {
      notificationSettings.save(next);
    } catch {
      // メモリ上の設定は変えない。画面には古い設定が残る。
      return c.json({ error: "settings_unavailable" }, 500);
    }
    return c.json(notificationView());
  };

  const parseNotificationUpdate = (
    body: unknown,
  ): Pick<NotificationSettings, "enabled" | "scope"> | null => {
    if (typeof body !== "object" || body === null) return null;
    const raw = body as { enabled?: unknown; scope?: unknown };
    if (typeof raw.enabled !== "boolean" || !isNotificationScope(raw.scope)) return null;
    return { enabled: raw.enabled, scope: raw.scope };
  };

  // 再起動コマンドが HWC 自身を止める場合、応答より先に起動するとその応答が落ちる。
  // 設定画面から押したときに失敗に見えないよう、応答を書き終えてから起動する。
  const scheduleRestart = (command: string, cwd: string) => {
    setTimeout(() => {
      const outcome = restart.run(command, cwd);
      if (outcome === "not_executable") console.error(`restart: ${command} is not executable`);
    }, restartDelayMs);
  };

  const parseRestartUpdate = (body: unknown): RestartSettings | null => {
    if (typeof body !== "object" || body === null) return null;
    const raw = body as { command?: unknown; afterPull?: unknown };
    if (typeof raw.afterPull !== "boolean") return null;
    const command = normalizeRestartCommand(raw.command ?? null);
    if (command === undefined) return null;
    return { command, afterPull: raw.afterPull };
  };

  return {
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
    projects,
    revision,
    sseHeartbeatMs,
    attachmentsRoot,
    previewRoots,
    notificationSettings,
    discordSender,
    restartSettings,
    restart,
    stateMessage,
    current,
    rootsFor,
    folderTrust,
    launchModels,
    paneFailure,
    worktreeFailure,
    workspaceFailure,
    closeSpaceFailure,
    requestClose,
    findPaneTab,
    matchesEtag,
    uploadAttachment,
    serveAttachment,
    notificationView,
    saveNotificationSettings,
    parseNotificationUpdate,
    scheduleRestart,
    parseRestartUpdate,
    closingSpaces,
    releaseClosingSpace,
    pruneClosingSpaces,
  };
}
