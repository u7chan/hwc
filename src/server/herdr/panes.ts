import { isAttachmentName, MAX_ATTACHMENTS } from "../../shared/attachments";
import { type PaneRead, parsePaneRead } from "./contract";
import { HerdrError, request } from "./socket";

export const READ_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
export type ReadSource = (typeof READ_SOURCES)[number];

// Herdr の `lines` は uint32。上限を超える値は Herdr 側で弾かれるので、こちらで 400 にする。
const MAX_LINES = 4_294_967_295;

// ペインへの入力を丸ごとソケットへ流す前に止める。手元の長文プロンプトには十分な大きさ。
export const MAX_TEXT_BYTES = 16_384;

export const TEXT_TOO_LONG = `text must be at most ${MAX_TEXT_BYTES} bytes`;
export const TEXT_WITH_ATTACHMENTS_TOO_LONG = `text and the attached files note must be at most ${MAX_TEXT_BYTES} bytes`;

export type PaneOutput = PaneRead;

export type ReadOptions = { paneId: string; source: ReadSource; lines?: number };

export type SendOptions = { paneId: string; text: string; submit: boolean };

export type InputBody = { text: string; submit: boolean; attachments: string[] };

export type FocusOptions = { paneId: string };

export type StopOptions = { paneId: string };

export type CloseOptions = { paneId: string };

export type PaneClient = {
  read: (options: ReadOptions) => Promise<PaneOutput>;
  send: (options: SendOptions) => Promise<void>;
  focus: (options: FocusOptions) => Promise<void>;
  stop: (options: StopOptions) => Promise<void>;
  close: (options: CloseOptions) => Promise<void>;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; status: 400 | 413; error: string };

export function parseOutputQuery(params: URLSearchParams): Parsed<Omit<ReadOptions, "paneId">> {
  const rawSource = params.get("source");
  if (rawSource !== null && !READ_SOURCES.includes(rawSource as ReadSource)) {
    return { ok: false, status: 400, error: `source must be one of ${READ_SOURCES.join(", ")}` };
  }
  const source = (rawSource ?? "recent") as ReadSource;

  const rawLines = params.get("lines");
  if (rawLines === null) return { ok: true, value: { source } };

  const lines = Number(rawLines);
  // Herdr は 0 も受理するが、0 行の出力を求める意味は無いので BFF で弾く。
  if (!/^\d+$/.test(rawLines) || lines < 1 || lines > MAX_LINES) {
    return { ok: false, status: 400, error: `lines must be an integer between 1 and ${MAX_LINES}` };
  }
  return { ok: true, value: { source, lines } };
}

export function parseInputBody(body: unknown): Parsed<InputBody> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be an object" };
  }

  const record = body as Record<string, unknown>;
  if (typeof record.text !== "string") {
    return { ok: false, status: 400, error: "text must be a string" };
  }

  const attachments = parseAttachments(record.attachments);
  if (attachments === null) {
    return { ok: false, status: 400, error: "attachments must be an array of attachment names" };
  }
  // 枚数の上限はメッセージ単位。1 枚の大きさはアップロード側で見る。
  if (attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, status: 400, error: `attachments must be at most ${MAX_ATTACHMENTS}` };
  }
  // 画像だけを送れるようにする。本文も添付も無いメッセージは送らない。
  if (record.text.trim() === "" && attachments.length === 0) {
    return { ok: false, status: 400, error: "text must be a non-empty string" };
  }
  if (record.submit !== undefined && typeof record.submit !== "boolean") {
    return { ok: false, status: 400, error: "submit must be a boolean" };
  }

  return { ok: true, value: { text: record.text, submit: record.submit === true, attachments } };
}

function parseAttachments(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isAttachmentName(item)) return null;
    names.push(item);
  }
  return names;
}

// 上限は注記を組み立てた後の本文で測る。文字数ではなくバイト数。
export function exceedsTextLimit(text: string): boolean {
  return new TextEncoder().encode(text).length > MAX_TEXT_BYTES;
}

export function isPaneNotFound(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "pane_not_found";
}

export function isInvalidRequest(error: unknown): boolean {
  return (
    error instanceof HerdrError &&
    (error.code === "invalid_params" || error.code === "invalid_request")
  );
}

type Caller = <T>(method: string, params?: unknown, options?: { path?: string }) => Promise<T>;

export function createPaneClient(options: { path?: string; call?: Caller } = {}): PaneClient {
  const { path } = options;
  const call: Caller = options.call ?? request;

  return {
    async read({ paneId, source, lines }) {
      const result = await call<unknown>(
        "pane.read",
        { pane_id: paneId, source, format: "text", ...(lines === undefined ? {} : { lines }) },
        { path },
      );
      return parsePaneRead(result, paneId);
    },
    async send({ paneId, text, submit }) {
      // 文字と Enter を 1 リクエストで送る。2 回に分けると、間で失敗したときに
      // 文字だけが残って再送で重複する。
      const params = submit
        ? { pane_id: paneId, text, keys: ["enter"] }
        : { pane_id: paneId, text };
      await call("pane.send_input", params, { path });
    },
    async focus({ paneId }) {
      // target はエージェント名も受けるが、hwc が持つのはペイン id だけ。
      await call("agent.focus", { target: paneId }, { path });
    },
    async stop({ paneId }) {
      // Herdr は Esc を esc として受ける。文字は送らず、キーだけを 1 回送る。
      await call("pane.send_keys", { pane_id: paneId, keys: ["esc"] }, { path });
    },
    async close({ paneId }) {
      // ペインを閉じるとエージェントのプロセスも終わる。開いていた作業は戻らない。
      await call("pane.close", { pane_id: paneId }, { path });
    },
  };
}
