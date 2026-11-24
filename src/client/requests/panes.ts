import type { ChatFile } from "../../server/chat/contract";
import type { PaneRead } from "../../server/herdr/contract";
import type { AnswerRequest } from "../../shared/answer";
import type { PaneCloseAction } from "../../shared/pane-close";
import { parseProjectList, type ProjectList } from "../../shared/projects";
import { type FolderTrustInteraction, type PaneInteraction } from "../../shared/confirmation";
import {
  encodeAttachmentName,
  FILENAME_HEADER,
  isStoredAttachmentName,
} from "../../shared/attachments";
import {
  type AgentKind,
  type AgentModel,
  isAgentEffort,
  supportsFolderTrust,
} from "../../shared/agents";
import { parseFileTree, type FileTreeListing } from "../../shared/file-tree";
import type { ModelSwitchRequest } from "../../shared/model-switch";
import type { PreviewWarning } from "../../shared/message-files";
import { parsePaneProcess, type PaneProcess } from "../../shared/panes";
import {
  CLOSE_TIMEOUT_MS,
  type CloseOutcome,
  asRecord,
  closeOutcome,
  client,
  createWithIds,
  paneParam,
  toCreationFailure,
  toErrorText,
  toId,
  toKnownError,
  withJson,
  type BodyResponse,
} from "../api";

export type OutputRead = PaneRead & { interaction: PaneInteraction | null };

// 1 回に読む行数。スマホの画面に収まる範囲に留め、全文は端末で読む。
export const OUTPUT_LINES = 200;
// 表示中のペインを読み直す間隔。状態の変化は SSE でも届くが、端末の出力は届かない。
export const OUTPUT_POLL_MS = 2_000;
export type InputBody = { text: string; submit: true; attachments?: string[] };

type StatusResponse = { ok: boolean; status: number };

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

export function toStartError(value: unknown): StartAgentFailure {
  return toKnownError(value, START_FAILURES);
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
  return toId(asRecord(value)?.paneId);
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
  const { error, paneId } = toCreationFailure(value, CREATE_FAILURES);
  return { error, paneId };
}

// エージェント起動・分割・リネーム・シェル準備待ちを含めた最悪値を覆う。ここを短くすると、
// ペインができた後にクライアントだけ諦めて、再試行で 2 枚目を作ってしまう。
export const CREATE_TIMEOUT_MS = 65_000;

// モデル指定時は cwd と候補を確認し、effort 指定なら対応段階も再取得する。
export const MODEL_CREATE_TIMEOUT_MS = 120_000;

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
