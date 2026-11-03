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

export function chatUrl(paneId: string): string {
  return `/api/panes/${encodeURIComponent(paneId)}/chat`;
}

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

export function outputUrl(paneId: string, lines: number = OUTPUT_LINES): string {
  const query = new URLSearchParams({ source: "recent", lines: String(lines) });
  return `/api/panes/${encodeURIComponent(paneId)}/output?${query.toString()}`;
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

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

export async function fetchState(signal?: AbortSignal): Promise<AppState> {
  const state = toAppState(await getJson("/api/state", signal));
  if (state === null) throw new Error("/api/state: unexpected body");
  return state;
}

export async function readOutput(paneId: string, signal?: AbortSignal): Promise<OutputRead> {
  const read = toPaneRead(await getJson(outputUrl(paneId), signal), paneId);
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
  const response = await fetch(chatUrl(paneId), { headers, signal });
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
  // BFF は application/json 以外を 415 で弾く。cross-origin の simple request に落とさない。
  const response = await fetch(`/api/panes/${encodeURIComponent(paneId)}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      attachments.length === 0 ? { text, submit: true } : { text, submit: true, attachments },
    ),
    signal,
  });
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

// body は読まれないので送らない。ヘッダは BFF が application/json 以外を 415 で弾くため付ける。
export function focusRequest(paneId: string): { url: string; init: RequestInit } {
  return {
    url: `/api/panes/${encodeURIComponent(paneId)}/focus`,
    init: { method: "POST", headers: { "content-type": "application/json" } },
  };
}

export async function focusAgent(paneId: string, signal?: AbortSignal): Promise<void> {
  const { url, init } = focusRequest(paneId);
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) throw new Error(`focus: ${response.status}`);
}
