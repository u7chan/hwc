import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  parseNotificationSettings,
} from "../shared/notifications";
import { parentPaneOf } from "../shared/parent-pane";
import type { PullRequest } from "../shared/pull-request";
import type { AppState, PaneState, StateStore, WorkspaceState } from "./herdr/state";
import { pullRequestBranches, type PullRequestReader } from "./pull-request";
import { createJsonStore, createStateFile, type JsonStore, type StateFile } from "./state-file";

// 設定ファイルの読み書き。中身は JSON のまま扱い、解釈は parseNotificationSettings に任せる。
export type NotificationSettingsFile = StateFile;

export function notificationSettingsPath(root: string): string {
  return join(root, "notifications.json");
}

// 添付・ペイン時刻と同じ状態ディレクトリ配下の 1 ファイル（docs/adr/state-storage.md）。Webhook URL は
// 資格情報なので 0600 で書く。
export function createNotificationSettingsFile(root: string): NotificationSettingsFile {
  return createStateFile(notificationSettingsPath(root), { mode: 0o600 });
}

export type NotificationSettingsStore = JsonStore<NotificationSettings>;

export function createNotificationSettingsStore(
  file: NotificationSettingsFile,
): NotificationSettingsStore {
  // トグル・scope・URL を同時に触られても食い違わないよう、設定はメモリ上にも持つ。
  return createJsonStore(file, { ...DEFAULT_NOTIFICATION_SETTINGS }, parseNotificationSettings);
}

export type DiscordSendError =
  | "discord_invalid_webhook"
  | "discord_rate_limited"
  | "discord_unavailable";

export type DiscordSendResult =
  | { ok: true }
  | { ok: false; error: DiscordSendError; retryAfter?: number };

export type DiscordSender = (webhookUrl: string, content: string) => Promise<DiscordSendResult>;

// Discord の応答を待つ上限。設定画面のテスト送信はこの外側に期限を置く。
export const DISCORD_TIMEOUT_MS = 8_000;

// @everyone / @here を無効にする。通知本文は hwc が組み立てたものだけを載せる。
export function toDiscordPayload(content: string) {
  return { content, allowed_mentions: { parse: [] as [] } };
}

export function createDiscordSender(
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    // E2E 専用。設定されていれば Discord へ POST せず、送信内容をファイルへ追記する。
    // 本番では設定しない（docs/e2e.md）。
    sinkPath?: string | null;
  } = {},
): DiscordSender {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DISCORD_TIMEOUT_MS;
  const sinkPath = options.sinkPath ?? null;

  return async (webhookUrl, content) => {
    if (sinkPath !== null) {
      appendFileSync(sinkPath, `${JSON.stringify({ content })}\n`);
      return { ok: true };
    }

    let response: Response;
    try {
      response = await send(`${webhookUrl}?wait=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toDiscordPayload(content)),
        // 3xx を追うと、検証したホスト以外へ本文を送りうる。追わずに失敗にする。
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // timeout も名前解決の失敗も、利用者にとっては「送れなかった」で同じ。
      return { ok: false, error: "discord_unavailable" };
    }

    const body = await response.text().catch(() => "");
    if (response.status >= 200 && response.status < 300) return { ok: true };
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { ok: false, error: "discord_invalid_webhook" };
    }
    if (response.status === 429) {
      const retryAfter = readRetryAfter(body, response.headers.get("retry-after"));
      return retryAfter === null
        ? { ok: false, error: "discord_rate_limited" }
        : { ok: false, error: "discord_rate_limited", retryAfter };
    }
    return { ok: false, error: "discord_unavailable" };
  };
}

// retryAfter は秒。Discord は本文の retry_after（小数）を返し、ヘッダにも秒を置く。
function readRetryAfter(body: string, header: string | null): number | null {
  const fromHeader = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  try {
    const value = (JSON.parse(body) as { retry_after?: unknown }).retry_after;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  } catch {
    // 本文が JSON でない 429 もある。ヘッダで読めなければ値なしで返す。
  }
  return null;
}

// スペースの親が done で、エージェントのいるペインが全員 done か idle のとき、
// そのスペースの作業は収束しているとみなす。シェルだけのペインは数えない。
export function isSettledWorkspace(workspace: WorkspaceState): boolean {
  const parent = parentPaneOf(workspace);
  if (parent === null || parent.agentStatus !== "done") return false;
  for (const tab of workspace.tabs) {
    for (const pane of tab.panes) {
      if (pane.agent === null) continue;
      if (pane.agentStatus !== "done" && pane.agentStatus !== "idle") return false;
    }
  }
  return true;
}

export function settledWorkspaceIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  for (const workspace of state.workspaces) {
    if (isSettledWorkspace(workspace)) ids.add(workspace.id);
  }
  return ids;
}

// 要対応は完了と違い、親やほかのペインの状態を待たない。答えるまで止まっている
// ペインそのものが対象なので、シェルを除いた全ペインを見る。
function isBlockedAgentPane(pane: PaneState): boolean {
  return pane.agent !== null && pane.agentStatus === "blocked";
}

export function blockedPaneIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (isBlockedAgentPane(pane)) ids.add(pane.id);
      }
    }
  }
  return ids;
}

function blockedPanesOf(workspace: WorkspaceState, paneIds: ReadonlySet<string>): PaneState[] {
  const panes: PaneState[] = [];
  for (const tab of workspace.tabs) {
    for (const pane of tab.panes) {
      if (paneIds.has(pane.id) && isBlockedAgentPane(pane)) panes.push(pane);
    }
  }
  return panes;
}

// 1 回の publish で同じスペースの複数ペインが要対応になっても、1 通にまとめる。
// ペインごとに送ると、同時に確認を求められたときに Discord のレート制限へ当たる。
function blockedPaneIdsByWorkspace(
  state: AppState,
  paneIds: ReadonlySet<string>,
): Array<{ workspaceId: string; paneIds: string[] }> {
  const groups: Array<{ workspaceId: string; paneIds: string[] }> = [];
  for (const workspace of state.workspaces) {
    const ids: string[] = [];
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (paneIds.has(pane.id)) ids.push(pane.id);
      }
    }
    if (ids.length > 0) groups.push({ workspaceId: workspace.id, paneIds: ids });
  }
  return groups;
}

// ラベルが無いペインはエージェント名、それも無ければ id で呼ぶ。
export function notificationPaneLabel(pane: PaneState): string {
  const label = pane.label?.trim() ?? "";
  if (label !== "") return label;
  return pane.agent ?? pane.id;
}

export function blockedNotificationContent(
  workspace: WorkspaceState,
  panes: readonly PaneState[],
): string {
  const head = `hwc: ${notificationWorkspaceLabel(workspace)} が対応を待っています`;
  const names = panes.map(notificationPaneLabel).join(", ");
  const branch = workspace.branch ?? null;
  const lines = [head, `ペイン: ${names}`];
  if (branch !== null) lines.push(`ブランチ: ${branch}`);
  return lines.join("\n");
}

export function pullRequestNotificationContent(pullRequest: PullRequest): string {
  return `hwc: PR #${pullRequest.number} の作業が完了しました\n${pullRequest.title}\n${pullRequest.url}`;
}

// ラベルが空のスペースでも、通知の見出しは空にしない。
export function notificationWorkspaceLabel(workspace: WorkspaceState): string {
  const label = workspace.label.trim();
  if (label !== "") return label;
  return workspace.worktree?.repoName ?? workspace.id;
}

export function workspaceNotificationContent(workspace: WorkspaceState): string {
  const head = `hwc: ${notificationWorkspaceLabel(workspace)} が完了しました`;
  const branch = workspace.branch ?? null;
  return branch === null ? head : `${head}\nブランチ: ${branch}`;
}

export type NotificationDispatcher = (state: AppState, observed: boolean) => void;

// 収束した瞬間と要対応になった瞬間に送り、そのまま留まっている間は再送しない。
// 完了通知は同じ PR の同じ head でも再送しない（docs/adr/discord-notification.md）。
// 送信は状態の publish を待たせない（PR の取得と POST は fire-and-forget）。
export function createNotificationDispatcher(options: {
  store: Pick<StateStore, "get" | "workspacePath">;
  settings: NotificationSettingsStore;
  sender: DiscordSender;
  pullRequests?: PullRequestReader;
  log?: (message: string) => void;
}): NotificationDispatcher {
  const log = options.log ?? ((message: string) => console.error(message));
  // 購読直後の最初の publish は、観測が続いているかに関係なく基準でしかない。
  let baseline = false;
  let settled = new Set<string>();
  let blocked = new Set<string>();
  let reportedFailure = false;
  // 同じ PR の同じ head では送らない。LGTM 収束後に会話で収束と解除を繰り返すだけで、
  // レビュー対象は変わっていない（docs/adr/discord-notification.md）。新しい head と
  // 別の PR は送る。
  const notifiedRevision = new Map<string, string>();

  const contentFor = async (
    workspace: WorkspaceState,
    scope: NotificationSettings["scope"],
  ): Promise<{ content: string; revision: string | null } | null> => {
    if (scope === "all") {
      return { content: workspaceNotificationContent(workspace), revision: null };
    }
    const branch = workspace.branch ?? null;
    const checkoutPath = options.store.workspacePath(workspace.id);
    if (branch === null || checkoutPath === null || options.pullRequests === undefined) return null;
    // ペイン見出しと同じように、push 先の名前で引く（docs/adr/git-github.md）。
    const branches = pullRequestBranches(branch, workspace.sync?.upstreamBranch ?? null);
    const pullRequest = await options
      .pullRequests({ checkoutPath, branches, refresh: true })
      .catch(() => null);
    // 古い open が残っていても、最新が open でなければ送らない。
    if (pullRequest === null || pullRequest.state !== "OPEN") return null;
    return {
      content: pullRequestNotificationContent(pullRequest),
      revision: `${pullRequest.number}:${pullRequest.headRefOid}`,
    };
  };

  const deliver = async (url: string, content: string): Promise<boolean> => {
    const result = await options.sender(url, content);
    if (result.ok) {
      reportedFailure = false;
      return true;
    }
    if (!reportedFailure) {
      reportedFailure = true;
      // URL は資格情報。失敗のログにも出さない。
      log(`discord notification: ${result.error}`);
    }
    return false;
  };

  const notifyWorkspace = async (workspaceId: string) => {
    const settings = options.settings.get();
    if (!settings.enabled || settings.discordWebhookUrl === null) return;
    const state = options.store.get();
    const workspace = state?.workspaces.find((item) => item.id === workspaceId);
    if (workspace === undefined || !isSettledWorkspace(workspace)) return;

    const resolved = await contentFor(workspace, settings.scope);
    if (resolved === null) return;
    const { content, revision } = resolved;
    if (revision !== null && notifiedRevision.get(workspaceId) === revision) return;

    // PR の取得を待つ間に状態か設定が動いていることがある。送信直前に読み直す。
    const latestSettings = options.settings.get();
    const url = latestSettings.discordWebhookUrl;
    if (!latestSettings.enabled || url === null) return;
    const latestState = options.store.get();
    const latestWorkspace = latestState?.workspaces.find((item) => item.id === workspaceId);
    if (latestWorkspace === undefined || !isSettledWorkspace(latestWorkspace)) return;

    // 送信を待つ間に同じ head の収束が来ても二重に送らないよう、送信前に記録する。
    if (revision !== null) notifiedRevision.set(workspaceId, revision);
    const delivered = await deliver(url, content);
    if (!delivered && revision !== null && notifiedRevision.get(workspaceId) === revision) {
      // 送れなかった head は、次の収束で送り直せるようにする。自動リトライはしない。
      notifiedRevision.delete(workspaceId);
    }
  };

  // scope は完了通知だけに効かせる。要対応は人間が答えるまで止まっているので、
  // PR の有無で絞ると見落とす。PR も引かない（gh の待ちで通知を遅らせない）。
  const notifyBlockedPanes = async (workspaceId: string, paneIds: readonly string[]) => {
    const settings = options.settings.get();
    const url = settings.discordWebhookUrl;
    if (!settings.enabled || url === null) return;
    const workspace = options.store.get()?.workspaces.find((item) => item.id === workspaceId);
    if (workspace === undefined) return;
    const panes = blockedPanesOf(workspace, new Set(paneIds));
    if (panes.length === 0) return;
    await deliver(url, blockedNotificationContent(workspace, panes));
  };

  const reportError = (error: unknown) => {
    log(`discord notification: ${error instanceof Error ? error.message : String(error)}`);
  };

  return (state, observed) => {
    const nextSettled = settledWorkspaceIds(state);
    const nextBlocked = blockedPaneIds(state);
    const enteredSettled =
      baseline && observed ? [...nextSettled].filter((id) => !settled.has(id)) : [];
    const enteredBlocked =
      baseline && observed ? [...nextBlocked].filter((id) => !blocked.has(id)) : [];
    // 判定と同時に基準を更新する。送信を待つ間に次の publish が来ても二重に送らない。
    settled = nextSettled;
    blocked = nextBlocked;
    baseline = true;
    for (const id of enteredSettled) {
      notifyWorkspace(id).catch(reportError);
    }
    const entered = new Set(enteredBlocked);
    for (const group of blockedPaneIdsByWorkspace(state, entered)) {
      notifyBlockedPanes(group.workspaceId, group.paneIds).catch(reportError);
    }
  };
}
