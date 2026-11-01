import { type PaneRead, parsePaneRead } from "./contract";
import { HerdrError, request } from "./socket";

export const READ_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
export type ReadSource = (typeof READ_SOURCES)[number];

// Herdr の `lines` は uint32。上限を超える値は Herdr 側で弾かれるので、こちらで 400 にする。
const MAX_LINES = 4_294_967_295;

// ペインへの入力を丸ごとソケットへ流す前に止める。手元の長文プロンプトには十分な大きさ。
const MAX_TEXT_LENGTH = 16_384;

export type PaneOutput = { paneId: string } & PaneRead;

export type ReadOptions = { paneId: string; source: ReadSource; lines?: number };

export type SendOptions = { paneId: string; text: string; submit: boolean };

export type PaneClient = {
  read: (options: ReadOptions) => Promise<PaneOutput>;
  send: (options: SendOptions) => Promise<void>;
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

export function parseInputBody(body: unknown): Parsed<Omit<SendOptions, "paneId">> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be an object" };
  }

  const record = body as Record<string, unknown>;
  if (typeof record.text !== "string" || record.text.trim() === "") {
    return { ok: false, status: 400, error: "text must be a non-empty string" };
  }
  if (record.text.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: `text must be at most ${MAX_TEXT_LENGTH} characters`,
    };
  }
  if (record.submit !== undefined && typeof record.submit !== "boolean") {
    return { ok: false, status: 400, error: "submit must be a boolean" };
  }
  return { ok: true, value: { text: record.text, submit: record.submit === true } };
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
  };
}
