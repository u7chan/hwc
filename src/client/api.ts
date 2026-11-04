import { hc } from "hono/client";
import type { AppType } from "../server/app";
import type {
  ChatCompaction,
  ChatContext,
  ChatMessage,
  ChatSnapshot,
} from "../server/chat/contract";
import type { PaneRead } from "../server/herdr/contract";
import type { AppState } from "../server/herdr/state";
import { isAttachmentName } from "../shared/attachments";

export type OutputRead = PaneRead;

// 1 回に読む行数。スマホの画面に収まる範囲に留め、全文は端末で読む。
export const OUTPUT_LINES = 200;
// 表示中のペインを読み直す間隔。状態の変化は SSE でも届くが、端末の出力は届かない。
export const OUTPUT_POLL_MS = 2_000;
// 実行中は返答が届き続けるので短く、待機中は追記が無いので長く寝かせる。
export const CHAT_POLL_ACTIVE_MS = 2_000;
export const CHAT_POLL_IDLE_MS = 5_000;

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

function toChatCompaction(value: unknown): ChatCompaction | null {
  if (typeof value !== "object" || value === null) return null;
  const compaction = value as Partial<ChatCompaction>;
  if (typeof compaction.at !== "number") return null;
  if (!isOptionalNumber(compaction.tokensBefore)) return null;
  if (typeof compaction.summary !== "string") return null;
  return { at: compaction.at, tokensBefore: compaction.tokensBefore, summary: compaction.summary };
}

function toAttachmentNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // 名前は配信 URL になる。書式の外れた値は捨て、リンクも画像も作らない。
  const names = value.filter(
    (item): item is string => typeof item === "string" && isAttachmentName(item),
  );
  return names.length === 0 ? undefined : names;
}

function toChatMessage(value: unknown): ChatMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Partial<ChatMessage>;
  if (typeof message.id !== "string") return null;
  if (message.role !== "user" && message.role !== "agent") return null;
  if (typeof message.text !== "string") return null;
  if (typeof message.at !== "number") return null;
  const attachments = toAttachmentNames(message.attachments);
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    at: message.at,
    ...(attachments === undefined ? {} : { attachments }),
  };
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
  return {
    etag: snapshot.etag,
    messages,
    model: snapshot.model,
    effort: snapshot.effort,
    truncated: snapshot.truncated,
    // 飾りの値が壊れても会話は捨てない。数字を出さないだけにする。
    context: toChatContext(snapshot.context),
    compaction: toChatCompaction(snapshot.compaction),
  };
}

export function attachmentUploadUrl(paneId: string): string {
  return `/api/panes/${encodeURIComponent(paneId)}/attachments`;
}

export function attachmentUrl(paneId: string, name: string): string {
  return `${attachmentUploadUrl(paneId)}/${encodeURIComponent(name)}`;
}

export function toAppState(value: unknown): AppState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<AppState>;
  if (!Array.isArray(state.workspaces)) return null;
  return state as AppState;
}

export function parseAppState(data: string): AppState | null {
  try {
    return toAppState(JSON.parse(data));
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
  return { paneId, text: read.text, truncated: read.truncated, revision: read.revision };
}

export async function fetchRevision(signal?: AbortSignal): Promise<string | null> {
  const response = await client.api.health.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`health: ${response.status}`);
  const body = await response.json();
  return typeof body.revision === "string" ? body.revision : null;
}

export async function fetchState(signal?: AbortSignal): Promise<AppState> {
  const response = await client.api.state.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`state: ${response.status}`);
  const state = toAppState(await response.json());
  if (state === null) throw new Error("state: unexpected body");
  return state;
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
export async function closePane(paneId: string): Promise<CloseOutcome> {
  try {
    const response = await client.api.panes[":id"].close.$post(paneParam(paneId), {
      headers: { "content-type": "application/json" },
      init: { signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) },
    });
    return closeOutcome(response.status);
  } catch {
    // 通信の失敗と打ち切りは、閉じられなかった結果として扱う。
    return "failed";
  }
}
