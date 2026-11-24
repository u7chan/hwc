import { homedir } from "node:os";
import type { Context, Env } from "hono";
import type { SessionChatClient } from "../chat/contract";
import { createFolderTrust } from "../folder-trust";
import { createLaunchModels } from "../launch-models";
import { createPiDefaults, loadPiDefaults, type PiDefaultsReader } from "../pi-defaults";
import { isInvalidRequest, isPaneNotFound, type PaneClient } from "../herdr/panes";
import { type AppState, findPane, type PaneState, type StateStore } from "../herdr/state";
import type { WorkspaceClient } from "../herdr/workspaces";
import type { WorktreeClient } from "../herdr/worktrees";
import type { PullRequestReader } from "../pull-request";
import {
  createDiscordSender,
  createNotificationSettingsStore,
  type DiscordSender,
  type NotificationSettingsStore,
} from "../notifications";
import type { GitClient } from "../git";
import { createProjectLister, type ProjectLister } from "../projects";
import {
  createRestartRunner,
  createRestartSettingsStore,
  type RestartRunner,
  type RestartSettingsStore,
} from "../restart";
import { createTemplatesStore, type TemplatesStore } from "../templates";
import { createLaunchDefaultsStore, type LaunchDefaultsStore } from "../launch-defaults";
import { defaultPreviewRoots } from "../message-files";
import type { AgentModelsClient } from "../agent-models";
import type { ClaudeModelLabelsReader } from "../claude-model-labels";
import { createModelSwitcher, hasLocalCommandOutputs } from "../model-switch";
import type { ClaudeSettingsProvider } from "../create-pane";
import { defaultAttachmentsRoot } from "../attachments";

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
  // Claude は transcript を読む。読めない構成（別ユーザー・別ホスト）でも、ペインの一覧や
  // 端末出力は使えるようにする。
  claude?: SessionChatClient;
  models?: AgentModelsClient;
  // Claude の alias を表示名に解決する。読めない構成では null のまま。
  modelLabels?: ClaudeModelLabelsReader;
  // Claude の起動に足す hook の設定ファイルを用意する。テストでは実ファイルを書かないよう、
  // 渡さない（hook なしで起動する）。
  claudeSettings?: ClaudeSettingsProvider;
  // モデルの切り替えで hook と受け渡す置き場（docs/adr/claude-integration.md）。無い構成では
  // 切り替えない。
  claudeSwitchRoot?: string;
  // pi の既定モデルは、チャット画面を開いたときに読む。テストでは実プロセスを
  // 起動しないよう差し替える。
  loadPiDefaults?: PiDefaultsReader;
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
  // 既定は /tmp と HWC_PREVIEW_ROOTS（docs/adr/file-serving.md）。
  previewRoots?: string[];
  // 通知設定の保存先と Webhook 送信器。テストでは実ファイル・実ネットワークを避けて差し替える。
  notificationSettings?: NotificationSettingsStore;
  discordSender?: DiscordSender;
  // 再起動コマンドの保存先と起動器。テストでは実プロセスを起動しないよう差し替える。
  restartSettings?: RestartSettingsStore;
  restart?: RestartRunner;
  restartDelayMs?: number;
  // 編集の rewind marker を待つ期限。テストでは短く差し替える。
  editMarkerTimeoutMs?: number;
  // 定型文の保存先。テストでは実ファイルへ書かないよう差し替える。
  templates?: TemplatesStore;
  // 新しいペインの既定モデル・effort の保存先。テストでは実ファイルへ書かないよう差し替える。
  launchDefaults?: LaunchDefaultsStore;
  // 設定画面の候補を読むディレクトリ。テストでは実ホームを渡さないよう差し替える。
  homeDirectory?: string;
  // グローバルスキルを探すホーム。E2E では架空のホームへ振り向け、実ホームのスキルを画面に出さない。
  skillsHome?: string;
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
    claude,
    models,
    modelLabels,
    claudeSettings,
    claudeSwitchRoot,
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
    editMarkerTimeoutMs = 10_000,
    templates = createTemplatesStore({ read: () => null, write: () => {} }),
    launchDefaults = createLaunchDefaultsStore({ read: () => null, write: () => {} }),
    homeDirectory = homedir(),
    skillsHome = homeDirectory,
    loadPiDefaults: readPiDefaults = loadPiDefaults,
  } = options;

  const current = async (): Promise<AppState | null> =>
    store.get() ??
    store.refresh().catch(() => {
      // 取得に失敗した時点で状態は無い。呼び出し側がエラーを返す。
      return null;
    });

  // 状態のキャッシュはイベントが届くまで古い。送信の直前だけ Herdr から取り直し、
  // キャッシュが idle のままでも実際に blocked なら送らない。取得できなければ呼び出し側が
  // fail closed にする。
  const freshPane = async (paneId: string): Promise<PaneState | null> => {
    const state = await store.refresh();
    return findPane(state, paneId);
  };

  // 状態とペインの前提は、応答の形（ステータスと error 文字列）ごとここで決める。
  // ルート固有の条件（会話やエージェント種別など）は、解決できた後に呼び出し側が足す。
  const resolveState = async (
    c: Context,
  ): Promise<{ ok: true; state: AppState } | { ok: false; response: Response }> => {
    const state = await current();
    if (state === null) {
      return { ok: false, response: c.json({ error: "herdr_unavailable" }, 502) };
    }
    return { ok: true, state };
  };

  const resolvePane = async (
    c: Context,
  ): Promise<
    | { ok: true; state: AppState; paneId: string; pane: PaneState }
    | { ok: false; response: Response }
  > => {
    const resolved = await resolveState(c);
    if (!resolved.ok) return resolved;
    const paneId = c.req.param("id") ?? "";
    const pane = findPane(resolved.state, paneId);
    if (pane === null) {
      return { ok: false, response: c.json({ error: "pane_not_found" }, 404) };
    }
    return { ok: true, state: resolved.state, paneId, pane };
  };

  const folderTrust = createFolderTrust(panes);
  const launchModels = createLaunchModels();
  // モデルの切り替えは、会話とローカルコマンドの結果を読める Claude のペインだけ。
  const modelSwitcher =
    hasLocalCommandOutputs(claude) && models !== undefined && claudeSwitchRoot !== undefined
      ? createModelSwitcher({ panes, chat: claude, models, launchModels, root: claudeSwitchRoot })
      : null;
  const piDefaults = createPiDefaults(readPiDefaults);

  const paneFailure = (c: Context, error: unknown) => {
    if (isPaneNotFound(error)) return c.json({ error: "pane_not_found" }, 404);
    if (isInvalidRequest(error)) return c.json({ error: "invalid_request" }, 400);
    return c.json({ error: "herdr_unavailable" }, 502);
  };

  // 再起動コマンドが HWC 自身を止める場合、応答より先に起動するとその応答が落ちる。
  // 設定画面から押したときに失敗に見えないよう、応答を書き終えてから起動する。
  const scheduleRestart = (command: string, cwd: string) => {
    setTimeout(() => {
      const outcome = restart.run(command, cwd);
      if (outcome === "not_executable") console.error(`restart: ${command} is not executable`);
    }, restartDelayMs);
  };

  return {
    store,
    panes,
    worktrees,
    workspaces,
    chat,
    opencode,
    codex,
    claude,
    models,
    modelLabels,
    claudeSettings,
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
    editMarkerTimeoutMs,
    templates,
    launchDefaults,
    homeDirectory,
    skillsHome,
    current,
    freshPane,
    resolveState,
    resolvePane,
    folderTrust,
    launchModels,
    piDefaults,
    modelSwitcher,
    paneFailure,
    scheduleRestart,
  };
}
