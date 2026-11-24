import { hc } from "hono/client";
import type { AppType } from "../server/app";
import type { ChatFile, ChatSnapshot } from "../server/chat/contract";
import type { PaneRead } from "../server/herdr/contract";
import type { AppState } from "../server/herdr/state";
import { parseFileTree, type FileTreeListing } from "../shared/file-tree";
import { toChatSnapshot } from "./chat-decode";
import type { AgentSkills } from "../shared/agent-skills";
import { parsePaneActivity, type PaneActivity } from "../shared/activity";
import type { AnswerRequest } from "../shared/answer";
import type { ModelSwitchRequest } from "../shared/model-switch";
import {
  type AgentKind,
  type AgentModel,
  type ModelAgentKind,
  type ModelLabels,
  isAgentEffort,
  isAgentModel,
  supportsFolderTrust,
} from "../shared/agents";
import {
  encodeAttachmentName,
  FILENAME_HEADER,
  isStoredAttachmentName,
} from "../shared/attachments";
import type { PaneCloseAction } from "../shared/pane-close";
import type { PreviewWarning } from "../shared/message-files";
import { parsePaneProcess, type PaneProcess } from "../shared/panes";
import type { FolderTrustInteraction, PaneInteraction } from "../shared/confirmation";
import { parseProjectList, type ProjectList } from "../shared/projects";
import {
  type NotificationScope,
  type NotificationView,
  parseNotificationView,
} from "../shared/notifications";
import { parsePullRequest, type PullRequest } from "../shared/pull-request";
import { parseRestartSettings, type RestartSettings } from "../shared/restart";
import { parseTemplates, type Template } from "../shared/templates";
import {
  type LaunchDefault,
  type LaunchDefaults,
  parseLaunchDefaults,
} from "../shared/launch-defaults";

// BFF 側の期限: Herdr ソケット 8 秒、エージェント起動 30 秒、worktree 60 秒、git 60 秒。
// クライアントの期限はこれを目安に置く。

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

// 同じ理由で、body は変数にしてから渡す。オブジェクト literal のままでは弾かれる。
function withJson<T>(param: { param: { id: string } }, json: T) {
  return { ...param, json };
}

// 304 は本文が無いだけで、手元の会話をそのまま使う。それ以外の失敗は、会話を出せない
// 応答として扱い、端末出力へ切り替える。
export function chatOutcome(status: number): ChatRead["kind"] {
  if (status === 304) return "unchanged";
  if (status >= 200 && status < 300) return "snapshot";
  return "unavailable";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// hc の応答は Response ではなく ClientResponse。どの口も読むのは ok と、本文か status だけ。
type BodyResponse = { ok: boolean; json: () => Promise<unknown> };
type StatusResponse = { ok: boolean; status: number };

// 既知のコードだけを通す判定とは別物。本文の error を文言にそのまま使う（通知・再起動・
// 定型文・編集）。既定は呼び出し側で違う（null / "unknown" / "edit_failed"）ので引数で受ける。
function toErrorText<F extends string | null>(value: unknown, fallback: F): string | F {
  const error = asRecord(value)?.error;
  return typeof error === "string" ? error : fallback;
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
export function previewUrl(paneId: string, file: { root: number; name: string }): string {
  const encoded = file.name.split("/").map(encodeURIComponent).join("/");
  return `/api/panes/${encodeURIComponent(paneId)}/preview/${file.root}/${encoded}`;
}

// 本文のリンクから開くテキストは、新しいタブで生の中身を読む。同じ URL を HTML のアセット
// としても使うため、.js / .css は実行可能な型で返る。text のときだけ raw を付けて
// text/plain にしてもらう（docs/adr/file-serving.md）。
export function previewTextUrl(paneId: string, file: { root: number; name: string }): string {
  return `${previewUrl(paneId, file)}?raw=1`;
}

// ツリーの 1 ディレクトリ。path は根からの相対パスで、空なら根。
// 取得できない理由（根が無い・根の外）は区別せず、画面は 1 行の失敗表示にする。
export async function readFileTree(
  paneId: string,
  path: string,
  signal: AbortSignal,
): Promise<FileTreeListing | null> {
  try {
    const input = { ...paneParam(paneId), query: { path } };
    const response = await client.api.panes[":id"].tree.$get(input, {
      init: { signal },
    });
    if (!response.ok) return null;
    return parseFileTree(await response.json());
  } catch {
    return null;
  }
}

// iframe に出す前に、配信できないスクリプトを読み込む HTML かをヘッダーだけで確かめる。
// hc は HEAD を出せないので、この 1 本だけ素の fetch を使う。親ページと同じオリジンから
// 送るので、sandbox の iframe とは別経路でヘッダーを読める。失敗と期限切れは案内を出さない。
export async function probePreviewWarning(
  paneId: string,
  file: ChatFile,
  signal: AbortSignal,
): Promise<PreviewWarning | null> {
  try {
    const response = await fetch(previewUrl(paneId, file), { method: "HEAD", signal });
    if (!response.ok) return null;
    // 未知の値は無視する。クライアントが知っている案内だけを出す。
    return response.headers.get("x-hwc-preview-warning") === "script" ? "script" : null;
  } catch {
    return null;
  }
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

// Herdr がイベントを出さない cwd とブランチを追うための取り直しを頼む。応答は状態ではない。
// 新しい状態は SSE で届くので、ここでは成否だけを見る（docs/adr/bff-client-transport.md）。
export async function refreshState(signal?: AbortSignal): Promise<void> {
  const response = await client.api.state.refresh.$post({ json: {} }, { init: { signal } });
  if (!response.ok) throw new Error(`state refresh: ${response.status}`);
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
export type ActivityRead = { activity: PaneActivity | null; session: string | null };

export async function readActivity(paneId: string, signal?: AbortSignal): Promise<ActivityRead> {
  const response = await client.api.panes[":id"].activity.$get(paneParam(paneId), {
    init: { signal },
  });
  if (!response.ok) throw new Error(`activity: ${response.status}`);
  const body = (await response.json()) as { activity?: unknown; session?: unknown };
  return {
    activity: parsePaneActivity(body.activity),
    session: parseActivitySession(body.session),
  };
}

// 保持中の値と比べるだけの id。空文字と制御文字は捨てる。
export function parseActivitySession(value: unknown): string | null {
  return typeof value === "string" && value !== "" && !/\p{Cc}/u.test(value) ? value : null;
}

// 会話にモデルが載るまでの表示に使う。値が無い場合と失敗は同じ null に畳む
// （表示だけの補い。docs/adr/agent-launch.md）。
export type ModelInfo = { model: string; effort: string | null };

export function toModelInfo(value: unknown): ModelInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const { model, effort } = value as { model?: unknown; effort?: unknown };
  if (typeof model !== "string" || model.trim() === "" || /\p{Cc}/u.test(model)) return null;
  if (effort === null || effort === undefined) return { model, effort: null };
  if (!isAgentEffort(effort)) return null;
  return { model, effort };
}

// 会話にモデルが載るまでの表示の補い。エンドポイントと、その意味だけが違う。
async function readModelInfo(
  read: (init: { signal: AbortSignal }) => Promise<BodyResponse>,
  signal: AbortSignal,
): Promise<ModelInfo | null> {
  try {
    const response = await read({ signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    return response.ok ? toModelInfo(await response.json()) : null;
  } catch {
    return null;
  }
}

export function readDefaultModel(paneId: string, signal: AbortSignal): Promise<ModelInfo | null> {
  return readModelInfo(
    (init) => client.api.panes[":id"]["default-model"].$get(paneParam(paneId), { init }),
    signal,
  );
}

// hwc から起動したときの指定は、会話がまだ読めない間の表示を補う。Claude は最初の
// メッセージまで transcript を作らないため、その間は会話ではなく端末出力になる。
export function readLaunchModel(paneId: string, signal: AbortSignal): Promise<ModelInfo | null> {
  return readModelInfo(
    (init) => client.api.panes[":id"]["launch-model"].$get(paneParam(paneId), { init }),
    signal,
  );
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

const GIT_SYNC_FAILURES: readonly GitSyncFailure[] = [
  "no_remote",
  "no_upstream",
  "not_git_worktree",
  "git_unavailable",
];

export type GitSyncOutcome = { ok: true } | { ok: false; error: GitSyncFailure };

// fetch / pull はネットワークと git の走査を伴う。
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
    const body: unknown = await response.json().catch(() => null);
    return { ok: false, error: toKnownError(body, GIT_SYNC_FAILURES) };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export const EDIT_TIMEOUT_MS = 15_000;

export type EditMessageResult = { ok: true } | { ok: false; error: string; rewound: boolean };

function editRequest(paneId: string, messageId: string, requestId: string, text: string) {
  return { ...paneParam(paneId), json: { messageId, requestId, text } };
}

// 編集は rewind の marker 待ち（BFF で最大 10 秒）を含むので、送信より長く待つ。
export async function editMessage(
  paneId: string,
  messageId: string,
  requestId: string,
  text: string,
): Promise<EditMessageResult> {
  try {
    const response = await client.api.panes[":id"]["edit-message"].$post(
      editRequest(paneId, messageId, requestId, text),
      { init: { signal: AbortSignal.timeout(EDIT_TIMEOUT_MS) } },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      rewound?: unknown;
    } | null;
    return {
      ok: false,
      error: toErrorText(body, "edit_failed"),
      rewound: body?.rewound === true,
    };
  } catch {
    return { ok: false, error: "network", rewound: false };
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
  let encoded: string;
  try {
    encoded = encodeAttachmentName(file.name);
  } catch {
    // encodeURIComponent は孤立したサロゲートで投げる。名前が無い要求は送らない。
    return { ok: false, status: 0 };
  }
  // 型は拡張子で決まるので、Content-Type は送れたら送るだけ。空文字は送らない。
  const headers: Record<string, string> = { [FILENAME_HEADER]: encoded };
  if (file.type !== "") headers["content-type"] = file.type;

  let response: Response;
  try {
    response = await fetch(attachmentUploadUrl(paneId), {
      method: "POST",
      headers,
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
  if (typeof name !== "string" || !isStoredAttachmentName(name)) return { ok: false, status: 0 };
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

// BFF は Esc で閉じて pending が消えるのを最大 3 秒待ってから本文を送る。その上限と通信を
// 覆い、返らない経路でカードを回し続けない。
export const ANSWER_TIMEOUT_MS = 15_000;

// status は失敗の理由を伝えるためだけに返す。0 はネットワークの失敗と打ち切り。
type PostStatusResult = { ok: true } | { ok: false; status: number };

export type AnswerResult = PostStatusResult;

// hc の応答を、期限と、失敗を status に畳む形が同じものに使う。何をどこへ送るかと
// 期限だけを呼び出し側が持つ。
async function postStatus(
  send: (signal: AbortSignal) => Promise<StatusResponse>,
  timeoutMs: number,
): Promise<PostStatusResult> {
  try {
    const response = await send(AbortSignal.timeout(timeoutMs));
    return response.ok ? { ok: true } : { ok: false, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function answerQuestion(paneId: string, request: AnswerRequest): Promise<AnswerResult> {
  return postStatus(
    (signal) =>
      client.api.panes[":id"]["answer-question"].$post(withJson(paneParam(paneId), request), {
        init: { signal },
      }),
    ANSWER_TIMEOUT_MS,
  );
}

// BFF は `/model` の完了を最大 8 秒、`/effort` の結果を最大 5 秒待つ。その上限と通信を覆い、
// 返らない経路でダイアログを回し続けない。
export const SWITCH_MODEL_TIMEOUT_MS = 20_000;

export type SwitchModelResult = PostStatusResult;

export function switchModel(
  paneId: string,
  request: ModelSwitchRequest,
): Promise<SwitchModelResult> {
  return postStatus(
    (signal) =>
      client.api.panes[":id"]["switch-model"].$post(withJson(paneParam(paneId), request), {
        init: { signal },
      }),
    SWITCH_MODEL_TIMEOUT_MS,
  );
}

export async function confirmFolderTrust(paneId: string, id: string): Promise<void> {
  const input = { ...paneParam(paneId), json: { id } };
  const response = await client.api.panes[":id"]["confirm-folder-trust"].$post(input, {
    init: { signal: AbortSignal.timeout(8_000) },
  });
  if (!response.ok) throw new Error(`confirm-folder-trust: ${response.status}`);
}

export async function focusAgent(paneId: string, signal?: AbortSignal): Promise<void> {
  // body は読まれないが、415 を避けて application/json を付ける。
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

// チェックアウトの削除は git の走査を含む。
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

// スペースを閉じる。ファイルは消さないので、削除より短い期限で足りる。
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

// 並びは Herdr の状態そのもの。取り直しの分を少し上乗せする。
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

// 既存のシェルペインで起動する要求。ペインは作らず名前も変えない。
export type StartAgentRequest = {
  agent: AgentKind;
  model: AgentModel | null;
  effort: string | null;
  // 分割直後のペインは、シェルが起動を受け付けるまで agent.start が busy を返す。
  waitForShell: boolean;
};

export type StartAgentFailure =
  | "agent_start_failed"
  | "pane_busy"
  | "pane_not_shell"
  | "pane_not_found"
  | "invalid_request"
  | "timeout"
  | "failed";

export type StartAgentOutcome = { ok: true } | { ok: false; error: StartAgentFailure };

const START_FAILURES: readonly StartAgentFailure[] = [
  "agent_start_failed",
  "pane_busy",
  "pane_not_shell",
  "pane_not_found",
  "invalid_request",
];

// 既知の error コードだけを通し、それ以外は既定へ落とす。既知の一覧は応答ごとに違う。
function toKnownError<F extends string>(value: unknown, known: readonly F[]): F | "failed" {
  const error = asRecord(value)?.error;
  return known.find((item) => item === error) ?? "failed";
}

export function toStartError(value: unknown): StartAgentFailure {
  return toKnownError(value, START_FAILURES);
}

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

export function toModelLabels(value: unknown): ModelLabels | null {
  if (typeof value !== "object" || value === null) return null;
  const labels = (value as { labels?: unknown }).labels;
  if (labels === null) return null;
  if (typeof labels !== "object" || Array.isArray(labels)) return null;
  const parsed: ModelLabels = {};
  for (const [key, label] of Object.entries(labels)) {
    if (key !== "" && typeof label === "string" && label !== "") parsed[key] = label;
  }
  return parsed;
}

// Claude の alias を表示名に解決する。候補とは別の口なので、読めなくても選べる。
export async function readModelLabels(signal: AbortSignal): Promise<ModelLabels | null> {
  try {
    const init = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
    const response = await client.api["model-labels"].$get(
      { query: { agent: "claude" } },
      { init },
    );
    return response.status === 200 ? toModelLabels(await response.json()) : null;
  } catch {
    return null;
  }
}

// paneId が null のときは設定画面の候補で、BFF がホームディレクトリで読む。
export async function readAgentModels(
  paneId: string | null,
  agent: ModelAgentKind,
  signal: AbortSignal,
): Promise<AgentModelsRead> {
  try {
    const init = { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) };
    const query = { query: { agent } };
    const response =
      paneId === null
        ? await client.api.models.$get(query, { init })
        : await client.api.panes[":id"].models.$get({ ...paneParam(paneId), ...query }, { init });
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
  paneId: string | null,
  agent: ModelAgentKind,
  model: AgentModel,
  signal: AbortSignal,
): Promise<string[] | null> {
  try {
    const init = { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) };
    const query = { query: { agent, provider: model.provider, model: model.id } };
    const response =
      paneId === null
        ? await client.api.efforts.$get(query, { init })
        : await client.api.panes[":id"].efforts.$get({ ...paneParam(paneId), ...query }, { init });
    if (!response.ok) return null;
    return toAgentEfforts(await response.json());
  } catch {
    return null;
  }
}

export function toLaunchDefaults(value: unknown): LaunchDefaults | null {
  if (typeof value !== "object" || value === null) return null;
  const defaults = (value as { defaults?: unknown }).defaults;
  if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) return null;
  return parseLaunchDefaults(defaults);
}

// 読めなかったときは null。作成ダイアログは既定なしとして開く。
export async function readLaunchDefaults(signal: AbortSignal): Promise<LaunchDefaults | null> {
  try {
    const response = await client.api["launch-defaults"].$get(
      {},
      { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) } },
    );
    if (!response.ok) return null;
    return toLaunchDefaults(await response.json());
  } catch {
    return null;
  }
}

export type LaunchDefaultSaveResult = { ok: true; defaults: LaunchDefaults } | { ok: false };

// その CLI がグローバルに認識するスキル。読めなかったときは null（保存値ではなく、毎回読む）。
export async function readAgentSkills(
  agent: ModelAgentKind,
  signal: AbortSignal,
): Promise<AgentSkills | null> {
  try {
    const response = await client.api.agents[":agent"].skills.$get(
      { param: { agent } },
      { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) } },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// value が null なら、そのエージェントの既定を解除する。
export async function saveLaunchDefault(
  agent: ModelAgentKind,
  value: LaunchDefault | null,
): Promise<LaunchDefaultSaveResult> {
  try {
    const response = await client.api["launch-defaults"].$put({ json: { agent, value } });
    if (!response.ok) return { ok: false };
    const defaults = toLaunchDefaults(await response.json());
    return defaults === null ? { ok: false } : { ok: true, defaults };
  } catch {
    return { ok: false };
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

function toId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// 作成の目的は新しいペイン。応答に ID が無いと開けないので、形が違えば失敗にする。
export function toCreatedPane(value: unknown): string | null {
  return toId(asRecord(value)?.paneId);
}

const CREATE_FAILURES: readonly CreatePaneFailure[] = [
  "agent_start_failed",
  "pane_rename_failed",
  "pane_limit",
  "pane_not_found",
  "invalid_request",
];

type CreationFailure<F extends string> = {
  error: F | "timeout" | "failed";
  workspaceId: string | null;
  paneId: string | null;
};

// 作成の失敗は部分成功した id を伴う。ID の有無で、再送してよい失敗かを見分ける。返る id の
// 範囲は作る対象で違うので広い形で返し、各関数の戻り値の型で絞る。
function toCreationFailure<F extends string>(
  value: unknown,
  known: readonly F[],
): CreationFailure<F> {
  const record = asRecord(value);
  return {
    error: toKnownError(value, known),
    workspaceId: toId(record?.workspaceId),
    paneId: toId(record?.paneId),
  };
}

// 分割の後に失敗した場合は paneId が付く。ペインが既にあるかをこの値で分ける。
export function toCreateError(value: unknown): { error: CreatePaneFailure; paneId: string | null } {
  const { error, paneId } = toCreationFailure(value, CREATE_FAILURES);
  return { error, paneId };
}

// エージェント起動・分割・リネーム・シェル準備待ちを含めた最悪値を覆う。ここを短くすると、
// ペインができた後にクライアントだけ諦めて、再試行で 2 枚目を作ってしまう。
export const CREATE_TIMEOUT_MS = 65_000;

// モデル指定時は cwd と候補を確認し、effort 指定なら対応段階も再取得する。
export const MODEL_CREATE_TIMEOUT_MS = 120_000;

// ワークツリー作成は worktree.create の待ちを含む。ここを短くすると、作成済みの
// ワークツリーを見失って再送してしまう。エージェントの起動はこの応答に含めない。
export const CREATE_WORKTREE_TIMEOUT_MS = 120_000;

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

// 既存のシェルペインでエージェントを起動する。分割は無いが、起動の待ちとモデル指定時の
// 再検証を含むので、作成と同じ期限で待つ。分割直後は waitForShell でシェルの準備も待つ。
export async function startAgent(
  paneId: string,
  request: StartAgentRequest,
): Promise<StartAgentOutcome> {
  const signal = AbortSignal.timeout(
    request.model === null ? CREATE_TIMEOUT_MS : MODEL_CREATE_TIMEOUT_MS,
  );
  try {
    const input = { ...paneParam(paneId), json: request };
    const response = await client.api.panes[":id"].agent.$post(input, { init: { signal } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: toStartError(body) };
    return { ok: true };
  } catch {
    // 起動したか確認できない。ペインは残るので、状態を見てからやり直してもらう。
    return { ok: false, error: signal.aborted ? "timeout" : "failed" };
  }
}

export type CreateWorktreeFailure =
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

// 作成の目的は新しいスペースの最初のペイン。どちらかの id が無いと開けないので失敗にする。
export function toCreatedSpace(value: unknown): { workspaceId: string; paneId: string } | null {
  const record = asRecord(value);
  const workspaceId = toId(record?.workspaceId);
  const paneId = toId(record?.paneId);
  return workspaceId === null || paneId === null ? null : { workspaceId, paneId };
}

export function toWorktreeError(value: unknown) {
  return toCreationFailure(value, WORKTREE_FAILURES);
}

// Herdr が作成失敗を明示した場合と、同じチェックアウトへの同時操作だけは待って再送できる。
// 期限切れ・通信断・worktree_open_failed は、チェックアウトができているか確認できない。
export function canRetryWorktree(error: CreateWorktreeFailure): boolean {
  return error === "worktree_create_failed" || error === "worktree_operation_in_progress";
}

export type CreateWorktreeRequest = { name: string | null };

// 作成系の骨格（要求 → 応答 → 成功 / 失敗 / catch）。スペースとペインの id を返す作成は
// 同じ形なので、エンドポイント・期限・失敗の読み方・要求の組み立てだけを呼び出し側が持つ。
async function createWithIds<F extends string>(
  send: (signal: AbortSignal) => Promise<BodyResponse>,
  toFailure: (body: unknown) => CreationFailure<F>,
  timeoutMs: number,
): Promise<
  { ok: true; workspaceId: string; paneId: string } | ({ ok: false } & CreationFailure<F>)
> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await send(signal);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, ...toFailure(body) };
    const created = toCreatedSpace(body);
    return created === null
      ? { ok: false, error: "failed", workspaceId: null, paneId: null }
      : { ok: true, ...created };
  } catch {
    // 応答が返らない・途中で切れた場合は、BFF が作成を終えているか分からない。作成済みを
    // 残したまま再送すると 2 つ目を作るので、期限切れと同じ結果不明に倒す。
    return {
      ok: false,
      error: signal.aborted ? "timeout" : "failed",
      workspaceId: null,
      paneId: null,
    };
  }
}

export function createWorktree(
  workspaceId: string,
  request: CreateWorktreeRequest,
): Promise<CreateWorktreeOutcome> {
  return createWithIds(
    (signal) =>
      client.api.workspaces[":id"]["create-worktree"].$post(
        withJson(workspaceParam(workspaceId), request),
        { init: { signal } },
      ),
    toWorktreeError,
    CREATE_WORKTREE_TIMEOUT_MS,
  );
}

export type CreateSpaceFailure =
  | "pane_rename_failed"
  | "pane_not_found"
  | "no_checkout"
  | "not_found"
  | "invalid_request"
  | "herdr_unavailable"
  | "timeout"
  | "failed";

export type CreateSpaceOutcome =
  | { ok: true; workspaceId: string; paneId: string }
  | { ok: false; error: CreateSpaceFailure; workspaceId: string | null; paneId: string | null };

const SPACE_FAILURES: readonly CreateSpaceFailure[] = [
  "pane_rename_failed",
  "pane_not_found",
  "no_checkout",
  "not_found",
  "invalid_request",
  "herdr_unavailable",
];

export function toSpaceError(value: unknown) {
  return toCreationFailure(value, SPACE_FAILURES);
}

// ツリーのフォルダを作業ディレクトリにしたスペースを作る。path はツリーの根からの相対パス。
export function createSpace(
  paneId: string,
  request: { path: string; name: string | null },
): Promise<CreateSpaceOutcome> {
  return createWithIds(
    (signal) =>
      client.api.panes[":id"]["create-space"].$post(withJson(paneParam(paneId), request), {
        init: { signal },
      }),
    toSpaceError,
    CREATE_TIMEOUT_MS,
  );
}

export type NotificationSaveResult =
  | { ok: true; view: NotificationView }
  | { ok: false; error: string | null };

// テスト送信は BFF が Discord の応答を待つ。BFF に届かないときにボタンが送信中のまま
// 残らないよう、外側にもう少し長い期限を置く。
export const TEST_NOTIFICATION_TIMEOUT_MS = 15_000;

async function toSaveResult(response: BodyResponse): Promise<NotificationSaveResult> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const view = parseNotificationView(body);
    return view === null ? { ok: false, error: null } : { ok: true, view };
  }
  return { ok: false, error: toErrorText(body, null) };
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
    // body は読まれないが、415 を避けて application/json を付ける。
    const response = await client.api.notifications.discord.test.$post(
      {},
      {
        headers: { "content-type": "application/json" },
        init: { signal: AbortSignal.timeout(TEST_NOTIFICATION_TIMEOUT_MS) },
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true };
    return { ok: false, error: toErrorText(body, "unknown") };
  } catch {
    // 期限切れと接続失敗はクライアント側でしか分からない。文言はコードで選ぶ。
    return { ok: false, error: "unreachable" };
  }
}

export async function fetchRestartSettings(signal?: AbortSignal): Promise<RestartSettings> {
  const response = await client.api.restart.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`restart: ${response.status}`);
  return parseRestartSettings(await response.json().catch(() => null));
}

export type RestartSaveResult =
  | { ok: true; view: RestartSettings }
  | { ok: false; error: string | null };

export async function saveRestartSettings(input: {
  command: string | null;
  afterPull: boolean;
}): Promise<RestartSaveResult> {
  try {
    const response = await client.api.restart.$put({ json: input });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, view: parseRestartSettings(body) };
    return { ok: false, error: toErrorText(body, null) };
  } catch {
    return { ok: false, error: null };
  }
}

export type RunRestartResult = "started" | "not_configured" | "not_executable" | "unreachable";

// 起動したかどうかだけを返す。コマンドが HWC を再起動する構成なら、この応答の直後に
// 接続が切れ、ページは自動で読み直される。
export async function runRestart(): Promise<RunRestartResult> {
  try {
    // body は読まれないが、BFF は application/json 以外を 415 で弾く。
    const response = await client.api.restart.$post({ json: {} });
    if (response.ok) return "started";
    const error = toErrorText(await response.json().catch(() => null), null);
    if (error === "command_not_configured") return "not_configured";
    if (error === "command_not_executable") return "not_executable";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function fetchTemplates(signal?: AbortSignal): Promise<Template[] | null> {
  try {
    const response = await client.api.templates.$get({}, { init: { signal } });
    if (!response.ok) return null;
    const body = (await response.json()) as { templates?: unknown };
    return parseTemplates(body.templates);
  } catch {
    return null;
  }
}

export type TemplateSaveResult =
  | { ok: true; templates: Template[] }
  | { ok: false; error: string | null };

export async function saveTemplates(templates: Template[]): Promise<TemplateSaveResult> {
  try {
    const response = await client.api.templates.$put({ json: { templates } });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed =
        typeof body === "object" && body !== null
          ? parseTemplates((body as { templates?: unknown }).templates)
          : null;
      return parsed === null ? { ok: false, error: null } : { ok: true, templates: parsed };
    }
    return { ok: false, error: toErrorText(body, null) };
  } catch {
    return { ok: false, error: null };
  }
}
