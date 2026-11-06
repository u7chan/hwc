import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { stripAttachedFiles } from "../../shared/attachments";
import type {
  ChatCompaction,
  ChatContext,
  ChatMessage,
  ChatSnapshot,
  ChatUsage,
  SessionChatClient,
} from "./contract";
import { ChatUnavailableError } from "./errors";
import { limitMessages } from "./limit";

// opencode の TUI はバックグラウンドサービスと HTTP で会話する。BFF も同じサービスを
// 読む。サービスが止まっている・別マシンで動いているときは端末出力へフォールバックする。
const SERVICE_TIMEOUT_MS = 5_000;
const MODEL_TIMEOUT_MS = 2_000;

const SERVICE_FILE = "service.json";
const SERVICE_USERNAME = "opencode";

export type OpencodeChatClient = SessionChatClient;

export type OpencodeService = {
  url: URL;
  authorization: string;
};

type Requester = (service: OpencodeService, path: string, timeoutMs: number) => Promise<unknown>;

type ModelRef = {
  id: string;
  providerID: string | null;
  variant: string | null;
};

type ModelCatalog = {
  contextWindow: (provider: string | null, model: string | null) => number | null;
};

type Projected = {
  messages: ChatMessage[];
  compaction: ChatCompaction | null;
  tokens: number | null;
  usage: ChatUsage | null;
  model: ModelRef | null;
  usageModel: ModelRef | null;
};

type SnapshotBody = Omit<ChatSnapshot, "etag">;

export function createOpencodeChatClient(
  options: {
    servicePath?: string;
    loadService?: () => Promise<OpencodeService>;
    request?: Requester;
  } = {},
): OpencodeChatClient {
  const loadService =
    options.loadService ?? (() => readServiceFile(options.servicePath ?? defaultServicePath()));
  const request = options.request ?? requestJson;
  const catalogs = new Map<string, Promise<ModelCatalog>>();

  const catalogFor = (
    service: OpencodeService,
    directory: string | null,
  ): Promise<ModelCatalog> => {
    const key = `${service.url.href}\u0000${directory ?? ""}`;
    const cached = catalogs.get(key);
    if (cached) return cached;

    const pending = loadCatalog(service, directory, request).catch((error: unknown) => {
      // 失敗を固定しない。opencode の起動直後はモデル一覧がまだ揃っていないことがある。
      catalogs.delete(key);
      throw error;
    });
    catalogs.set(key, pending);
    return pending;
  };

  return {
    async snapshot(sessionId) {
      const service = await loadService();
      const path = `/api/session/${encodeURIComponent(sessionId)}`;
      const [session, context] = await Promise.all([
        request(service, path, SERVICE_TIMEOUT_MS),
        request(service, `${path}/context`, SERVICE_TIMEOUT_MS),
      ]);

      const info = parseSession(session);
      const projected = parseContext(context);
      const model = info.model ?? projected.model;
      // window は表示中のモデルで引く。usage を出したモデルで引くと、モデルを切り替えた直後に
      // 新しいモデル名と古いモデルの window が混ざる（pi と同じ扱い）。
      const windowModel = info.model ?? projected.usageModel ?? projected.model;
      const contextWindow =
        windowModel === null
          ? null
          : await catalogFor(service, info.directory)
              .then((catalog) => catalog.contextWindow(windowModel.providerID, windowModel.id))
              .catch(() => null);

      const limited = limitMessages(projected.messages);
      const body: SnapshotBody = {
        messages: limited.messages,
        model: model?.id ?? null,
        effort: info.model === null ? (projected.model?.variant ?? null) : info.model.variant,
        truncated: limited.truncated,
        context: foldContext(projected.tokens, contextWindow),
        ...(projected.usage === null ? {} : { usage: projected.usage }),
        compaction: projected.compaction,
      };

      return { ...body, etag: etagOf(sessionId, body) };
    },
  };
}

export function defaultServicePath(): string {
  const stateHome = process.env.XDG_STATE_HOME;
  const root =
    stateHome !== undefined && isAbsolute(stateHome)
      ? stateHome
      : join(homedir(), ".local", "state");
  return join(root, "opencode", SERVICE_FILE);
}

export async function readServiceFile(path = defaultServicePath()): Promise<OpencodeService> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ChatUnavailableError("opencode service is not available");
  }

  const record = asRecord(raw);
  const password = nonEmptyText(record?.password);
  const urlText = nonEmptyText(record?.url);
  if (password === null || urlText === null) {
    throw new ChatUnavailableError("opencode service file is incomplete");
  }

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new ChatUnavailableError("opencode service url is invalid");
  }
  // service.json はホスト上のファイルだが、BFF が任意の URL へパスワードを送らないよう
  // loopback だけを許す。opencode の既定の待ち受けは 127.0.0.1。
  if (url.protocol !== "http:" || !isLoopback(url.hostname)) {
    throw new ChatUnavailableError("opencode service is not on loopback");
  }

  return {
    url,
    authorization: `Basic ${Buffer.from(`${SERVICE_USERNAME}:${password}`).toString("base64")}`,
  };
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export async function requestJson(
  service: OpencodeService,
  path: string,
  timeoutMs: number,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, service.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: service.authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ChatUnavailableError("opencode service did not answer");
  }

  if (!response.ok) {
    throw new ChatUnavailableError(`opencode service answered ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ChatUnavailableError("opencode service returned invalid json");
  }
}

function parseSession(raw: unknown): { model: ModelRef | null; directory: string | null } {
  const data = asRecord(asRecord(raw)?.data);
  if (data === null) throw new ChatUnavailableError("opencode session is missing");
  return {
    model: parseModelRef(data.model),
    directory: nonEmptyText(asRecord(data.location)?.directory),
  };
}

function parseContext(raw: unknown): Projected {
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) throw new ChatUnavailableError("opencode context is missing");

  const messages: ChatMessage[] = [];
  let compaction: ChatCompaction | null = null;
  let tokens: number | null = null;
  let parts: ChatUsage | null = null;
  let model: ModelRef | null = null;
  let usageModel: ModelRef | null = null;

  for (const item of data) {
    const record = asRecord(item);
    const type = record?.type;
    if (record === null || typeof type !== "string") continue;

    if (type === "compaction") {
      // 失敗・実行中の圧縮は文脈の区切りにしない。完了した要約だけを窓の先頭にする。
      if (record.status !== "completed") continue;
      const summary = nonEmptyText(record.summary);
      if (summary === null) continue;
      compaction = { at: timestampOf(record.time), tokensBefore: null, summary, index: 0 };
      messages.length = 0;
      tokens = null;
      parts = null;
      model = null;
      usageModel = null;
      continue;
    }

    if (type === "user") {
      const text = typeof record.text === "string" ? record.text : "";
      const stripped = stripAttachedFiles(text);
      if (stripped.text === "" && stripped.attachments.length === 0) continue;
      const id = nonEmptyText(record.id);
      if (id === null) continue;
      messages.push({
        id,
        role: "user",
        text: stripped.text,
        at: timestampOf(record.time),
        ...(stripped.attachments.length === 0 ? {} : { attachments: stripped.attachments }),
      });
      continue;
    }

    if (type === "assistant") {
      const ref = parseModelRef(record.model);
      if (ref !== null) model = ref;
      const usage = tokenTotal(record.tokens);
      // opencode の TUI は output を持つ最後の assistant をコンテキスト量にする。ツールだけの
      // 中間応答で usage を上書きしない。
      const output = finiteNumber(asRecord(record.tokens)?.output) ?? 0;
      if (usage !== null && output > 0) {
        tokens = usage;
        parts = tokenParts(record.tokens);
        usageModel = ref;
      }

      const text = assistantText(record.content);
      if (text === "") continue;
      const id = nonEmptyText(record.id);
      if (id === null) continue;
      messages.push({ id, role: "agent", text, at: timestampOf(record.time) });
    }
  }

  return { messages, compaction, tokens, usage: parts, model, usageModel };
}

function tokenParts(value: unknown): ChatUsage | null {
  const tokens = asRecord(value);
  if (tokens === null) return null;
  const cache = asRecord(tokens.cache);
  const part = (value: unknown) => {
    const n = finiteNumber(value);
    return n !== null && n >= 0 ? n : null;
  };
  const result = {
    input: part(tokens.input),
    output: part(tokens.output),
    cacheRead: part(cache?.read),
    cacheWrite: part(cache?.write),
    reasoning: part(tokens.reasoning),
  };
  return Object.values(result).some((n) => n !== null) ? result : null;
}

function parseModelRef(value: unknown): ModelRef | null {
  const record = asRecord(value);
  const id = nonEmptyText(record?.id);
  if (id === null) return null;
  return {
    id,
    providerID: nonEmptyText(record?.providerID),
    variant: nonEmptyText(record?.variant),
  };
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const part = asRecord(item);
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    if (part.text.trim() === "") continue;
    parts.push(part.text);
  }
  // ツールを挟んだ本文は、そのまま連結すると語がくっつく。段落として分ける。
  return parts.join("\n\n");
}

// opencode の TUI は input / output / reasoning / cache の合計をコンテキスト量として出す。
// 0 はまだ usage が無いのと同じなので null にする。
function tokenTotal(value: unknown): number | null {
  const tokens = asRecord(value);
  if (tokens === null) return null;
  const cache = asRecord(tokens.cache);
  const total =
    (finiteNumber(tokens.input) ?? 0) +
    (finiteNumber(tokens.output) ?? 0) +
    (finiteNumber(tokens.reasoning) ?? 0) +
    (finiteNumber(cache?.read) ?? 0) +
    (finiteNumber(cache?.write) ?? 0);
  return total > 0 ? total : null;
}

function timestampOf(time: unknown): number {
  return finiteNumber(asRecord(time)?.created) ?? 0;
}

async function loadCatalog(
  service: OpencodeService,
  directory: string | null,
  request: Requester,
): Promise<ModelCatalog> {
  const params = new URLSearchParams();
  if (directory !== null) params.set("location[directory]", directory);
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  const raw = await request(service, `/api/model${query}`, MODEL_TIMEOUT_MS);
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) throw new ChatUnavailableError("opencode model list is missing");

  const windows = new Map<string, number>();
  for (const item of data) {
    const record = asRecord(item);
    const id = nonEmptyText(record?.id);
    const provider = nonEmptyText(record?.providerID);
    if (id === null || provider === null) continue;
    const window = positiveNumber(asRecord(record?.limit)?.context);
    if (window !== null) windows.set(catalogKey(provider, id), window);
  }

  return {
    contextWindow(provider, model) {
      if (provider === null || model === null) return null;
      return windows.get(catalogKey(provider, model)) ?? null;
    },
  };
}

function catalogKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function foldContext(tokens: number | null, window: number | null): ChatContext | null {
  if (tokens === null && window === null) return null;
  return { tokens, window };
}

function etagOf(sessionId: string, body: SnapshotBody): string {
  const prefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  const content = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 20);
  return `${prefix}-${content}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}
