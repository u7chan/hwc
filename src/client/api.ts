import { hc } from "hono/client";
import type { AppType } from "../server/app";
import type {
  ChatCompaction,
  ChatContext,
  ChatFile,
  ChatMessage,
  ChatSnapshot,
  ChatUsage,
} from "../server/chat/contract";
import type { PaneRead } from "../server/herdr/contract";
import type { AppState } from "../server/herdr/state";
import { parsePaneActivity, type PaneActivity } from "../shared/activity";
import {
  type AgentKind,
  type AgentModel,
  type ModelAgentKind,
  isAgentEffort,
  isAgentModel,
  supportsFolderTrust,
} from "../shared/agents";
import { isAttachmentName } from "../shared/attachments";
import type { PaneCloseAction } from "../shared/pane-close";
import { parsePaneProcess, type PaneProcess } from "../shared/panes";
import type { FolderTrustInteraction, PaneInteraction } from "../shared/confirmation";
import { parseProjectList, type ProjectList } from "../shared/projects";
import {
  type NotificationScope,
  type NotificationView,
  parseNotificationView,
} from "../shared/notifications";
import { parsePullRequest, type PullRequest } from "../shared/pull-request";

export type OutputRead = PaneRead & { interaction: PaneInteraction | null };

// 1 回に読む行数。スマホの画面に収まる範囲に留め、全文は端末で読む。
export const OUTPUT_LINES = 200;
// 表示中のペインを読み直す間隔。状態の変化は SSE でも届くが、端末の出力は届かない。
export const OUTPUT_POLL_MS = 2_000;
// 実行中は返答が届き続けるので短く、待機中は追記が無いので長く寝かせる。
export const CHAT_POLL_ACTIVE_MS = 2_000;
export const CHAT_POLL_IDLE_MS = 5_000;
// 実行中の段階は 1 秒で十分。thinking の末尾が追いつく程度に短くする。
export const ACTIVITY_POLL_MS = 1_000;

export type ChatRead =
  | { kind: "snapshot"; snapshot: ChatSnapshot }
  | { kind: "unchanged" }
  | { kind: "unavailable" };

// テストでは絶対 URL を渡して $url を確かめる。本番は同一 origin なので空でよい。
export function createApiClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}

const client = createApiClient("");

// hc は path param をエスケープしない。ペイン id を 1 セグメントに保つ。
export function paneParam(paneId: string) {
  return { param: { id: encodeURIComponent(paneId) } };
}

// スペースの id も同じく 1 セグメントに保つ。
export function workspaceParam(workspaceId: string) {
  return { param: { id: encodeURIComponent(workspaceId) } };
}

// hc は validator のない query / body を入力型に含めない。実行時はそのまま送れるので、
// ここで形を決めて渡す。
export type InputBody = { text: string; submit: true; attachments?: string[] };

// 304 は本文が無いだけで、手元の会話をそのまま使う。それ以外の失敗は、会話を出せない
// 応答として扱い、端末出力へ切り替える。
export function chatOutcome(status: number): ChatRead["kind"] {
  if (status === 304) return "unchanged";
  if (status >= 200 && status < 300) return "snapshot";
  return "unavailable";
}

function isOptionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function toChatContext(value: unknown): ChatContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = value as Partial<ChatContext>;
  if (!isOptionalNumber(context.tokens) || !isOptionalNumber(context.window)) return null;
  return { tokens: context.tokens, window: context.window };
}

function toChatUsage(value: unknown): ChatUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Partial<ChatUsage>;
  const valid = (n: unknown): n is number | null =>
    n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  if (
    !valid(usage.input) ||
    !valid(usage.output) ||
    !valid(usage.cacheRead) ||
    !valid(usage.cacheWrite) ||
    !valid(usage.reasoning)
  )
    return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
  };
}

function toChatCompaction(value: unknown): ChatCompaction | null {
  if (typeof value !== "object" || value === null) return null;
  const compaction = value as Partial<ChatCompaction>;
  if (typeof compaction.at !== "number") return null;
  if (!isOptionalNumber(compaction.tokensBefore)) return null;
  if (typeof compaction.summary !== "string") return null;
  if (!isIndex(compaction.index)) return null;
  return {
    at: compaction.at,
    tokensBefore: compaction.tokensBefore,
    summary: compaction.summary,
    index: compaction.index,
  };
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function toAttachmentNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // 名前は配信 URL になる。書式の外れた値は捨て、リンクも画像も作らない。
  const names = value.filter(
    (item): item is string => typeof item === "string" && isAttachmentName(item),
  );
  return names.length === 0 ? undefined : names;
}

function toImageRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // 本文の表記と突き合わせるだけの値。配信 URL には使わないが、壊れた値は描画に使わない。
  const refs = value.filter((item): item is string => typeof item === "string" && item !== "");
  return refs.length === 0 ? undefined : refs;
}

function toChatFiles(value: unknown): ChatFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: ChatFile[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const file = item as Partial<ChatFile>;
    if (typeof file.name !== "string" || typeof file.version !== "string") continue;
    // 見せ方を知らないファイルは出さない。画像とプレビューだけを扱う。
    if (file.kind !== "image" && file.kind !== "html") continue;
    // 根の番号は配信 URL の一部になる。負数や小数は捨てる。
    if (typeof file.root !== "number" || !Number.isInteger(file.root) || file.root < 0) continue;
    // 配信 URL になる。根の外を指す名前は捨て、リンクも画像も作らない。
    if (file.name === "" || file.name.startsWith("/")) continue;
    if (file.name.split("/").includes("..")) continue;
    const imageRefs = toImageRefs(file.imageRefs);
    files.push({
      name: file.name,
      version: file.version,
      kind: file.kind,
      root: file.root,
      ...(imageRefs === undefined ? {} : { imageRefs }),
    });
  }
  return files.length === 0 ? undefined : files;
}

function toChatMessage(value: unknown): ChatMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Partial<ChatMessage>;
  if (typeof message.id !== "string") return null;
  if (message.role !== "user" && message.role !== "agent" && message.role !== "error") {
    return null;
  }
  if (typeof message.text !== "string") return null;
  if (typeof message.at !== "number") return null;
  const attachments = toAttachmentNames(message.attachments);
  const files = toChatFiles(message.files);
  const outsideFile = toOutsideFile(message.outsideFile);
  const count = message.role === "error" ? toRetryCount(message.count) : undefined;
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    at: message.at,
    ...(count === undefined ? {} : { count }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(files === undefined ? {} : { files }),
    ...(outsideFile === undefined ? {} : { outsideFile }),
  };
}

// 案内に出すのは名前だけ。区切りを含む値は、サーバーが契約を破ったということなので描かない。
function toOutsideFile(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (value.includes("/") || value.includes("\\")) return undefined;
  return value;
}

// 1 回だけの失敗は count を持たない。飾りの値が壊れても失敗の行は捨てない。
function toRetryCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : undefined;
}

export function toChatSnapshot(value: unknown): ChatSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const snapshot = value as Partial<ChatSnapshot>;
  if (typeof snapshot.etag !== "string") return null;
  if (typeof snapshot.truncated !== "boolean") return null;
  if (!isOptionalText(snapshot.model) || !isOptionalText(snapshot.effort)) return null;
  if (!Array.isArray(snapshot.messages)) return null;
  const messages: ChatMessage[] = [];
  for (const value of snapshot.messages) {
    const message = toChatMessage(value);
    if (message === null) return null;
    messages.push(message);
  }
  const usage = toChatUsage(snapshot.usage);
  return {
    etag: snapshot.etag,
    messages,
    model: snapshot.model,
    effort: snapshot.effort,
    truncated: snapshot.truncated,
    // 飾りの値が壊れても会話は捨てない。数字を出さないだけにする。
    context: toChatContext(snapshot.context),
    ...(usage === undefined ? {} : { usage }),
    compaction: toChatCompaction(snapshot.compaction),
  };
}

export function attachmentUploadUrl(paneId: string): string {
  return `/api/panes/${encodeURIComponent(paneId)}/attachments`;
}

export function attachmentUrl(paneId: string, name: string): string {
  return `${attachmentUploadUrl(paneId)}/${encodeURIComponent(name)}`;
}

// 根の番号と版を URL に含める。根が無いと、同名ファイルが別の根にあるときに配信先を
// 取り違える。版は、同じ名前で作り直された画像をブラウザのキャッシュから拾わないため。
export function chatFileUrl(paneId: string, file: ChatFile): string {
  const query = `root=${file.root}&path=${encodeURIComponent(file.name)}&v=${encodeURIComponent(file.version)}`;
  return `/api/panes/${encodeURIComponent(paneId)}/files?${query}`;
}

// パス形式にするのは、HTML の中の相対参照（`./app.css`）をそのまま解決させるため。
// 先頭の根の番号もパスに入れて、相対参照が別の根へずれないようにする。
export function previewUrl(paneId: string, file: ChatFile): string {
  const encoded = file.name.split("/").map(encodeURIComponent).join("/");
  return `/api/panes/${encodeURIComponent(paneId)}/preview/${file.root}/${encoded}`;
}

export function toAppState(value: unknown): AppState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<AppState>;
  if (!Array.isArray(state.workspaces)) return null;
  return state as AppState;
}

// 状態と、送信時のサーバー時刻。クライアントは now で時計を合わせる。
export type StateMessage = { state: AppState; now: number | null };

export function toStateMessage(value: unknown): StateMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as { state?: unknown; now?: unknown };
  const state = toAppState(message.state);
  if (state === null) return null;
  // 読めない now では時計を合わせ直さない。前回の差をそのまま使う。
  const now = typeof message.now === "number" && Number.isFinite(message.now) ? message.now : null;
  return { state, now };
}

export function parseAppState(data: string): StateMessage | null {
  try {
    return toStateMessage(JSON.parse(data));
  } catch {
    return null;
  }
}

export function toPaneRead(value: unknown, paneId: string): OutputRead | null {
  if (typeof value !== "object" || value === null) return null;
  const read = value as Partial<OutputRead>;
  if (read.paneId !== paneId) return null;
  if (typeof read.text !== "string") return null;
  if (typeof read.truncated !== "boolean") return null;
  if (typeof read.revision !== "number") return null;
  return {
    paneId,
    text: read.text,
    truncated: read.truncated,
    revision: read.revision,
    interaction: toPaneInteraction(read.interaction),
  };
}

export function toPaneInteraction(value: unknown): PaneInteraction | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return { kind: "terminal" };
  const interaction = value as Partial<FolderTrustInteraction>;
  if (
    interaction.kind === "folder-trust" &&
    supportsFolderTrust(interaction.agent) &&
    typeof interaction.id === "string" &&
    interaction.id !== "" &&
    typeof interaction.directory === "string" &&
    interaction.directory !== "" &&
    typeof interaction.submitted === "boolean"
  ) {
    return {
      kind: interaction.kind,
      id: interaction.id,
      agent: interaction.agent,
      directory: interaction.directory,
      submitted: interaction.submitted,
    };
  }
  return { kind: "terminal" };
}

export async function fetchRevision(signal?: AbortSignal): Promise<string | null> {
  const response = await client.api.health.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`health: ${response.status}`);
  const body = await response.json();
  return typeof body.revision === "string" ? body.revision : null;
}

export async function fetchState(signal?: AbortSignal): Promise<StateMessage> {
  const response = await client.api.state.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`state: ${response.status}`);
  const message = toStateMessage(await response.json());
  if (message === null) throw new Error("state: unexpected body");
  return message;
}

export function outputQuery(lines: number = OUTPUT_LINES) {
  return { source: "recent" as const, lines: String(lines) };
}

export function outputRequest(paneId: string) {
  return { ...paneParam(paneId), query: outputQuery() };
}

export function inputRequest(paneId: string, text: string, attachments: readonly string[] = []) {
  const json: InputBody =
    attachments.length === 0
      ? { text, submit: true }
      : { text, submit: true, attachments: [...attachments] };
  return { ...paneParam(paneId), json };
}

export async function readOutput(paneId: string, signal?: AbortSignal): Promise<OutputRead> {
  const response = await client.api.panes[":id"].output.$get(outputRequest(paneId), {
    init: { signal },
  });
  if (!response.ok) throw new Error(`output: ${response.status}`);
  const read = toPaneRead(await response.json(), paneId);
  if (read === null) throw new Error("output: unexpected body");
  return read;
}

export async function readChat(
  paneId: string,
  etag: string | null,
  signal?: AbortSignal,
): Promise<ChatRead> {
  const headers: Record<string, string> = {};
  // 手元に会話が無いのに 304 を返させない。条件は持っているときだけ付ける。
  if (etag !== null) headers["if-none-match"] = `"${etag}"`;
  const response = await client.api.panes[":id"].chat.$get(paneParam(paneId), {
    headers,
    init: { signal },
  });
  const outcome = chatOutcome(response.status);
  if (outcome === "unchanged") return { kind: "unchanged" };
  if (outcome === "unavailable") return { kind: "unavailable" };
  const snapshot = toChatSnapshot(await response.json());
  if (snapshot === null) return { kind: "unavailable" };
  return { kind: "snapshot", snapshot };
}

// 会話とは別の使い捨ての取得口。ETag も持たず、取れなければ null に畳む。
export async function readActivity(
  paneId: string,
  signal?: AbortSignal,
): Promise<PaneActivity | null> {
  const response = await client.api.panes[":id"].activity.$get(paneParam(paneId), {
    init: { signal },
  });
  if (!response.ok) throw new Error(`activity: ${response.status}`);
  const body = (await response.json()) as { activity?: unknown };
  return parsePaneActivity(body.activity);
}

// プロジェクト候補は、入力欄から選ぶときにだけ読む。失敗は候補なしではなく
// ダイアログの再試行に回すため、null に畳んで返す。
export async function readProjects(
  paneId: string,
  signal?: AbortSignal,
): Promise<ProjectList | null> {
  try {
    const response = await client.api.panes[":id"].projects.$get(paneParam(paneId), {
      init: { signal },
    });
    if (!response.ok) return null;
    return parseProjectList(await response.json());
  } catch {
    return null;
  }
}

// シェルの前景プロセス。Herdr のイベントで降ってこないので、見えている間だけ読む。
export async function readPaneProcess(paneId: string, signal?: AbortSignal): Promise<PaneProcess> {
  const response = await client.api.panes[":id"].process.$get(paneParam(paneId), {
    init: { signal },
  });
  if (!response.ok) throw new Error(`process: ${response.status}`);
  const body = (await response.json()) as { process?: unknown };
  return parsePaneProcess(body.process);
}

// ブランチから引いた最新の PR。チップや概要を出すためだけの値なので、失敗は null に畳む。
export async function readPullRequest(
  workspaceId: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<PullRequest | null> {
  // BFF のキャッシュを飛ばすのは、一覧に戻ったときだけ。通常の取得はキャッシュに任せる。
  const input =
    options.refresh === true
      ? { ...workspaceParam(workspaceId), query: { refresh: "1" } }
      : workspaceParam(workspaceId);
  const response = await client.api.workspaces[":id"]["pull-request"].$get(input, {
    init: { signal: options.signal },
  });
  if (!response.ok) throw new Error(`pull-request: ${response.status}`);
  const body = (await response.json()) as { pullRequest?: unknown };
  return parsePullRequest(body.pullRequest);
}

export type GitSyncFailure =
  | "no_remote"
  | "no_upstream"
  | "not_git_worktree"
  | "git_unavailable"
  | "failed";

export type GitSyncOutcome = { ok: true } | { ok: false; error: GitSyncFailure };

// fetch / pull はネットワークと git の走査を伴う。BFF の git 期限（60 秒）を覆う。
export const GIT_SYNC_TIMEOUT_MS = 70_000;

export async function syncWorkspace(
  workspaceId: string,
  action: "fetch" | "pull",
): Promise<GitSyncOutcome> {
  try {
    const input = { ...workspaceParam(workspaceId), json: { action } };
    const response = await client.api.workspaces[":id"].git.$post(input, {
      init: { signal: AbortSignal.timeout(GIT_SYNC_TIMEOUT_MS) },
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const error = body?.error;
    if (
      error === "no_remote" ||
      error === "no_upstream" ||
      error === "not_git_worktree" ||
      error === "git_unavailable"
    ) {
      return { ok: false, error };
    }
    return { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export async function sendInput(
  paneId: string,
  text: string,
  attachments: readonly string[] = [],
  signal?: AbortSignal,
): Promise<void> {
  // BFF は application/json 以外を 415 で弾く。hc に JSON body を作らせる。
  const response = await client.api.panes[":id"].input.$post(
    inputRequest(paneId, text, attachments),
    { init: { signal } },
  );
  if (!response.ok) throw new Error(`input: ${response.status}`);
}

// 保存名はサーバが決める。status は失敗の理由を notice に伝えるためだけに返す。
export type UploadResult = { ok: true; name: string } | { ok: false; status: number };

export async function uploadAttachment(
  paneId: string,
  file: File,
  signal?: AbortSignal,
): Promise<UploadResult> {
  let response: Response;
  try {
    // 生バイトで送る。Content-Type は BFF の allowlist 判定に使うので file.type をそのまま渡す。
    response = await fetch(attachmentUploadUrl(paneId), {
      method: "POST",
      headers: { "content-type": file.type },
      body: file,
      signal,
    });
  } catch {
    // 通信の失敗と打ち切りは呼び出し側が signal で見分ける。
    return { ok: false, status: 0 };
  }
  if (!response.ok) return { ok: false, status: response.status };

  const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
  const name = body?.name;
  if (typeof name !== "string" || !isAttachmentName(name)) return { ok: false, status: 0 };
  return { ok: true, name };
}

// Esc を送るだけなら即座に返る。返らない経路でボタンを回し続けないよう切る。
export const STOP_TIMEOUT_MS = 8_000;

export async function stopAgent(paneId: string): Promise<void> {
  const response = await client.api.panes[":id"].stop.$post(paneParam(paneId), {
    headers: { "content-type": "application/json" },
    init: { signal: AbortSignal.timeout(STOP_TIMEOUT_MS) },
  });
  if (!response.ok) throw new Error(`stop: ${response.status}`);
}

export async function confirmFolderTrust(paneId: string, id: string): Promise<void> {
  const input = { ...paneParam(paneId), json: { id } };
  const response = await client.api.panes[":id"]["confirm-folder-trust"].$post(input, {
    init: { signal: AbortSignal.timeout(8_000) },
  });
  if (!response.ok) throw new Error(`confirm-folder-trust: ${response.status}`);
}

export async function focusAgent(paneId: string, signal?: AbortSignal): Promise<void> {
  // body は読まれないが、BFF は application/json 以外を 415 で弾く。
  const response = await client.api.panes[":id"].focus.$post(paneParam(paneId), {
    headers: { "content-type": "application/json" },
    init: { signal },
  });
  if (!response.ok) throw new Error(`focus: ${response.status}`);
}

export type CloseOutcome = "done" | "failed";

// ペインが無い（BFF の状態に無い / Herdr が pane_not_found）なら、閉じる目的は達している。
export function closeOutcome(status: number): CloseOutcome {
  return status === 404 || (status >= 200 && status < 300) ? "done" : "failed";
}

// 送信中はダイアログから出られないので、応答が返らない経路をここで切る。
// BFF に届いた場合は Herdr 側の期限で終わるが、届かないと fetch が返らない。
export const CLOSE_TIMEOUT_MS = 8_000;

// 失敗も戻り値で返す。呼び出し側は結果の反映を 1 回だけ行えばよい。
export async function closePane(paneId: string, action: PaneCloseAction): Promise<CloseOutcome> {
  try {
    const response = await client.api.panes[":id"][action].$post(paneParam(paneId), {
      headers: { "content-type": "application/json" },
      init: { signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) },
    });
    return closeOutcome(response.status);
  } catch {
    // 通信の失敗と打ち切りは、閉じられなかった結果として扱う。
    return "failed";
  }
}

// 画面のクリアは短いが、BFF に届かない場合にメニューが待ち続けないよう期限を置く。
export const CLEAR_OUTPUT_TIMEOUT_MS = 8_000;

// ペインが無いなら、消す対象も無い。close と同じく目的の状態には達している。
export async function clearPaneOutput(paneId: string): Promise<boolean> {
  try {
    const response = await client.api.panes[":id"]["clear-output"].$post(paneParam(paneId), {
      headers: { "content-type": "application/json" },
      init: { signal: AbortSignal.timeout(CLEAR_OUTPUT_TIMEOUT_MS) },
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

// チェックアウトの削除は git の走査を含む。BFF のソケット期限（60 秒）より長く待つ。
export const REMOVE_WORKTREE_TIMEOUT_MS = 70_000;
// 消えたワークツリーは目的の状態に達している。close と同じく 404 は成功として扱う。
export async function removeWorktree(workspaceId: string): Promise<CloseOutcome> {
  try {
    const response = await client.api.workspaces[":id"]["remove-worktree"].$post(
      workspaceParam(workspaceId),
      {
        headers: { "content-type": "application/json" },
        init: { signal: AbortSignal.timeout(REMOVE_WORKTREE_TIMEOUT_MS) },
      },
    );
    return closeOutcome(response.status);
  } catch {
    return "failed";
  }
}

// 重複したネイティブスペースを閉じる。ファイルは消さないので、削除より短い期限で足りる。
// 消えたスペースは目的の状態に達しているため、close と同じく 404 は成功として扱う。
export async function closeWorkspace(workspaceId: string): Promise<CloseOutcome> {
  try {
    const response = await client.api.workspaces[":id"].close.$post(workspaceParam(workspaceId), {
      headers: { "content-type": "application/json" },
      init: { signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) },
    });
    return closeOutcome(response.status);
  } catch {
    return "failed";
  }
}

// 並びは Herdr の状態そのもの。ソケットの期限（8 秒）と取り直しの分を少し上乗せする。
export const MOVE_WORKSPACES_TIMEOUT_MS = 10_000;

export async function moveWorkspaceBlock(
  workspaceIds: readonly string[],
  beforeWorkspaceId: string | null,
): Promise<boolean> {
  try {
    const response = await client.api.workspaces.move.$post(
      { json: { workspaceIds: [...workspaceIds], beforeWorkspaceId } },
      { init: { signal: AbortSignal.timeout(MOVE_WORKSPACES_TIMEOUT_MS) } },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export type CreatePaneRequest = {
  name: string | null;
  agent: AgentKind | null;
  model: AgentModel | null;
  effort: string | null;
};

export function toAgentModels(value: unknown): AgentModel[] | null {
  if (typeof value !== "object" || value === null) return null;
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models) || !models.every(isAgentModel)) return null;
  return models.map(({ provider, id }) => ({ provider, id }));
}

export type AgentModelsRead = AgentModel[] | "opencode_not_running" | null;

export function agentModelsOutcome(status: number, value: unknown): AgentModelsRead {
  if (
    status === 502 &&
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error === "opencode_not_running"
  )
    return "opencode_not_running";
  return status >= 200 && status < 300 ? toAgentModels(value) : null;
}

export async function readAgentModels(
  paneId: string,
  agent: ModelAgentKind,
  signal: AbortSignal,
): Promise<AgentModelsRead> {
  try {
    const input = { ...paneParam(paneId), query: { agent } };
    const response = await client.api.panes[":id"].models.$get(input, {
      init: { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
    });
    return agentModelsOutcome(response.status, await response.json());
  } catch {
    return null;
  }
}

export function toAgentEfforts(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null) return null;
  const efforts = (value as { efforts?: unknown }).efforts;
  if (!Array.isArray(efforts) || !efforts.every(isAgentEffort)) return null;
  return [...new Set(efforts)];
}

export async function readAgentEfforts(
  paneId: string,
  agent: ModelAgentKind,
  model: AgentModel,
  signal: AbortSignal,
): Promise<string[] | null> {
  try {
    const input = {
      ...paneParam(paneId),
      query: { agent, provider: model.provider, model: model.id },
    };
    const response = await client.api.panes[":id"].efforts.$get(input, {
      init: { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
    });
    if (!response.ok) return null;
    return toAgentEfforts(await response.json());
  } catch {
    return null;
  }
}

export type CreatePaneFailure =
  | "agent_start_failed"
  | "pane_rename_failed"
  | "pane_limit"
  | "pane_not_found"
  | "invalid_request"
  | "timeout"
  | "failed";

export type CreatePaneOutcome =
  | { ok: true; paneId: string }
  | { ok: false; error: CreatePaneFailure; paneId: string | null };

// 作成の目的は新しいペイン。応答に ID が無いと開けないので、形が違えば失敗にする。
export function toCreatedPane(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const paneId = (value as { paneId?: unknown }).paneId;
  return typeof paneId === "string" && paneId !== "" ? paneId : null;
}

const CREATE_FAILURES: readonly CreatePaneFailure[] = [
  "agent_start_failed",
  "pane_rename_failed",
  "pane_limit",
  "pane_not_found",
  "invalid_request",
];

// 分割の後に失敗した場合は paneId が付く。ペインが既にあるかをこの値で分ける。
export function toCreateError(value: unknown): { error: CreatePaneFailure; paneId: string | null } {
  if (typeof value !== "object" || value === null) return { error: "failed", paneId: null };
  const record = value as { error?: unknown; paneId?: unknown };
  const error =
    typeof record.error === "string" && CREATE_FAILURES.includes(record.error as CreatePaneFailure)
      ? (record.error as CreatePaneFailure)
      : "failed";
  const paneId = typeof record.paneId === "string" && record.paneId !== "" ? record.paneId : null;
  return { error, paneId };
}

// エージェントの起動は Herdr 側で最大 30 秒待つ。分割・リネームのソケット期限（各 8 秒）と
// シェル準備待ち（5 秒）を含めた最悪値を覆う。ここを短くすると、ペインができた後に
// クライアントだけ諦めて、再試行で 2 枚目を作ってしまう。
export const CREATE_TIMEOUT_MS = 65_000;

// モデル指定時は cwd と候補を確認し、effort 指定なら対応段階も再取得する。
export const MODEL_CREATE_TIMEOUT_MS = 120_000;

// ワークツリー作成は 1 リクエストで worktree.create（ソケット期限 60 秒）とエージェント起動
// （30 秒）を行う。ここを短くすると、作成済みのワークツリーを見失って再送してしまう。
export const CREATE_WORKTREE_TIMEOUT_MS = 120_000;

// モデル指定時は root pane の cwd で候補・effort を再検証する。
export const MODEL_CREATE_WORKTREE_TIMEOUT_MS = 180_000;

export async function createPane(
  paneId: string,
  request: CreatePaneRequest,
): Promise<CreatePaneOutcome> {
  const signal = AbortSignal.timeout(
    request.model === null ? CREATE_TIMEOUT_MS : MODEL_CREATE_TIMEOUT_MS,
  );
  try {
    const input = { ...paneParam(paneId), json: request };
    const response = await client.api.panes[":id"].split.$post(input, {
      init: { signal },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, ...toCreateError(body) };
    const created = toCreatedPane(body);
    return created === null
      ? { ok: false, error: "failed", paneId: null }
      : { ok: true, paneId: created };
  } catch {
    // WebKit は AbortSignal.timeout で中断した fetch を TimeoutError ではなく AbortError で
    // 返す。reject の名前ではなく signal 自体を見て、ペインができているか確認できない
    // 期限切れを通常の失敗と分ける。
    return { ok: false, error: signal.aborted ? "timeout" : "failed", paneId: null };
  }
}

export type CreateWorktreeFailure =
  | "agent_start_failed"
  | "pane_rename_failed"
  | "worktree_create_failed"
  | "worktree_open_failed"
  | "worktree_operation_in_progress"
  | "linked_worktree_source"
  | "not_git_worktree"
  | "workspace_not_found"
  | "invalid_request"
  | "herdr_unavailable"
  | "timeout"
  | "failed";

export type CreateWorktreeOutcome =
  | { ok: true; workspaceId: string; paneId: string }
  | { ok: false; error: CreateWorktreeFailure; workspaceId: string | null; paneId: string | null };

const WORKTREE_FAILURES: readonly CreateWorktreeFailure[] = [
  "agent_start_failed",
  "pane_rename_failed",
  "worktree_create_failed",
  "worktree_open_failed",
  "worktree_operation_in_progress",
  "linked_worktree_source",
  "not_git_worktree",
  "workspace_not_found",
  "invalid_request",
  "herdr_unavailable",
];

function toId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// 作成の目的は新しいワークツリーの最初のペイン。どちらかの id が無いと開けないので失敗にする。
export function toCreatedWorktree(value: unknown): { workspaceId: string; paneId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { workspaceId?: unknown; paneId?: unknown };
  const workspaceId = toId(record.workspaceId);
  const paneId = toId(record.paneId);
  return workspaceId === null || paneId === null ? null : { workspaceId, paneId };
}

// 部分成功はペインが既にある。ID の有無で、再送してよい失敗かを見分ける。
export function toWorktreeError(value: unknown): {
  error: CreateWorktreeFailure;
  workspaceId: string | null;
  paneId: string | null;
} {
  if (typeof value !== "object" || value === null) {
    return { error: "failed", workspaceId: null, paneId: null };
  }
  const record = value as { error?: unknown; workspaceId?: unknown; paneId?: unknown };
  const error =
    typeof record.error === "string" &&
    WORKTREE_FAILURES.includes(record.error as CreateWorktreeFailure)
      ? (record.error as CreateWorktreeFailure)
      : "failed";
  return { error, workspaceId: toId(record.workspaceId), paneId: toId(record.paneId) };
}

// Herdr が作成失敗を明示した場合と、同じチェックアウトへの同時操作だけは待って再送できる。
// 期限切れ・通信断・worktree_open_failed は、チェックアウトができているか確認できない。
export function canRetryWorktree(error: CreateWorktreeFailure): boolean {
  return error === "worktree_create_failed" || error === "worktree_operation_in_progress";
}

export async function createWorktree(
  workspaceId: string,
  request: CreatePaneRequest,
): Promise<CreateWorktreeOutcome> {
  const signal = AbortSignal.timeout(
    request.model === null ? CREATE_WORKTREE_TIMEOUT_MS : MODEL_CREATE_WORKTREE_TIMEOUT_MS,
  );
  try {
    const input = { ...workspaceParam(workspaceId), json: request };
    const response = await client.api.workspaces[":id"]["create-worktree"].$post(input, {
      init: { signal },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, ...toWorktreeError(body) };
    const created = toCreatedWorktree(body);
    return created === null
      ? { ok: false, error: "failed", workspaceId: null, paneId: null }
      : { ok: true, ...created };
  } catch {
    // 応答が返らない・途中で切れた場合は、BFF が作成を終えているか分からない。作成済みの
    // ワークツリーを残したまま再送すると 2 つ目を作るので、期限切れと同じ結果不明に倒す。
    return {
      ok: false,
      error: signal.aborted ? "timeout" : "failed",
      workspaceId: null,
      paneId: null,
    };
  }
}

export type NotificationSaveResult =
  | { ok: true; view: NotificationView }
  | { ok: false; error: string | null };

// テスト送信は BFF が Discord の応答を 8 秒まで待つ。BFF に届かないときにボタンが
// 送信中のまま残らないよう、外側にもう少し長い期限を置く。
export const TEST_NOTIFICATION_TIMEOUT_MS = 15_000;

// hc の応答は Response ではなく ClientResponse。読むのは ok と本文だけ。
async function toSaveResult(response: {
  ok: boolean;
  json: () => Promise<unknown>;
}): Promise<NotificationSaveResult> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const view = parseNotificationView(body);
    return view === null ? { ok: false, error: null } : { ok: true, view };
  }
  const error =
    typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
  return { ok: false, error: typeof error === "string" ? error : null };
}

export async function fetchNotifications(signal?: AbortSignal): Promise<NotificationView> {
  const response = await client.api.notifications.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`notifications: ${response.status}`);
  const view = parseNotificationView(await response.json().catch(() => null));
  if (view === null) throw new Error("notifications: unexpected body");
  return view;
}

export async function saveNotificationSettings(input: {
  enabled: boolean;
  scope: NotificationScope;
}): Promise<NotificationSaveResult> {
  try {
    const response = await client.api.notifications.$put({ json: input });
    return await toSaveResult(response);
  } catch {
    return { ok: false, error: null };
  }
}

export async function saveDiscordWebhook(url: string): Promise<NotificationSaveResult> {
  try {
    const response = await client.api.notifications.discord.$put({ json: { url } });
    return await toSaveResult(response);
  } catch {
    return { ok: false, error: null };
  }
}

export async function removeDiscordWebhook(): Promise<NotificationSaveResult> {
  try {
    const response = await client.api.notifications.discord.$delete({});
    return await toSaveResult(response);
  } catch {
    return { ok: false, error: null };
  }
}

export type NotificationTestResult = { ok: true } | { ok: false; error: string };

// 状態ではなく BFF が返す error コードで文言を決める。BFF の 404 と Discord の 404 は
// 別物で、ここではどちらもコードに畳まれている。
export async function testDiscordWebhook(): Promise<NotificationTestResult> {
  try {
    // body は読まれないが、BFF は application/json 以外を 415 で弾く。
    const response = await client.api.notifications.discord.test.$post(
      {},
      {
        headers: { "content-type": "application/json" },
        init: { signal: AbortSignal.timeout(TEST_NOTIFICATION_TIMEOUT_MS) },
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true };
    const error =
      typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
    return { ok: false, error: typeof error === "string" ? error : "unknown" };
  } catch {
    // 期限切れと接続失敗はクライアント側でしか分からない。文言はコードで選ぶ。
    return { ok: false, error: "unreachable" };
  }
}
