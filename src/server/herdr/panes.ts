import { type PaneRead, parsePaneRead } from "./contract";
import { HerdrError, request } from "./socket";

export const READ_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
export type ReadSource = (typeof READ_SOURCES)[number];

// Herdr の `lines` は uint32。上限を超える値は Herdr 側で弾かれるので、こちらで 400 にする。
const MAX_LINES = 4_294_967_295;

export type PaneOutput = { paneId: string } & PaneRead;

export type ReadOptions = { paneId: string; source: ReadSource; lines?: number };

export type SendOptions = { paneId: string; text: string; submit: boolean };

export type PaneClient = {
  read: (options: ReadOptions) => Promise<PaneOutput>;
  send: (options: SendOptions) => Promise<void>;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseOutputQuery(params: URLSearchParams): Parsed<Omit<ReadOptions, "paneId">> {
  const rawSource = params.get("source");
  if (rawSource !== null && !READ_SOURCES.includes(rawSource as ReadSource)) {
    return { ok: false, error: `source must be one of ${READ_SOURCES.join(", ")}` };
  }
  const source = (rawSource ?? "recent") as ReadSource;

  const rawLines = params.get("lines");
  if (rawLines === null) return { ok: true, value: { source } };

  const lines = Number(rawLines);
  if (!/^\d+$/.test(rawLines) || lines < 1 || lines > MAX_LINES) {
    return { ok: false, error: `lines must be an integer between 1 and ${MAX_LINES}` };
  }
  return { ok: true, value: { source, lines } };
}

export function parseInputBody(body: unknown): Parsed<Omit<SendOptions, "paneId">> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }

  const record = body as Record<string, unknown>;
  if (typeof record.text !== "string" || record.text.trim() === "") {
    return { ok: false, error: "text must be a non-empty string" };
  }
  if (record.submit !== undefined && typeof record.submit !== "boolean") {
    return { ok: false, error: "submit must be a boolean" };
  }
  return { ok: true, value: { text: record.text, submit: record.submit === true } };
}

export function isPaneNotFound(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "pane_not_found";
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
      return { paneId, ...parsePaneRead(result) };
    },
    async send({ paneId, text, submit }) {
      await call("pane.send_text", { pane_id: paneId, text }, { path });
      // 改行は send_text では送れない。Enter は別のキー入力として送る。
      if (submit) await call("pane.send_keys", { pane_id: paneId, keys: ["Enter"] }, { path });
    },
  };
}
