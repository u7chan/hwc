import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;

type WireError = { code?: string; message?: string };

type WireMessage = {
  id?: string;
  result?: { type?: string } & Record<string, unknown>;
  error?: WireError;
  event?: string;
  data?: unknown;
};

type LineReader = {
  push: (chunk: string) => void;
};

export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "HerdrError";
    this.code = code;
  }
}

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const base = join(env.HOME || homedir(), ".config", "herdr");
  return env.HERDR_SESSION
    ? join(base, "sessions", env.HERDR_SESSION, "herdr.sock")
    : join(base, "herdr.sock");
}

function createLineReader(
  onLine: (line: string) => void,
  onOverflow: (message: string) => void,
): LineReader {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) onLine(line);
        end = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_MESSAGE_CHARS) {
        buffer = "";
        onOverflow("response exceeded the line buffer limit");
      }
    },
  };
}

function parseMessage(line: string): WireMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as WireMessage) : null;
  } catch {
    return null;
  }
}

let sequence = 0;

export type RequestOptions = {
  path?: string;
  timeoutMs?: number;
};

export function request<T>(
  method: string,
  params: unknown = {},
  options: RequestOptions = {},
): Promise<T> {
  const path = options.path ?? socketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const id = `hwc-${++sequence}`;

  return new Promise<T>((resolve, reject) => {
    const socket = net.connect(path);
    socket.setEncoding("utf8");

    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      complete();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`${method}: timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const reader = createLineReader(
      (line) => {
        const message = parseMessage(line);
        if (!message) {
          settle(() => reject(new Error(`${method}: invalid JSON from Herdr`)));
          return;
        }
        // Herdr replies with an empty id only when it cannot tell which request the line belongs to.
        if (message.id !== undefined && message.id !== "" && message.id !== id) return;
        const error = message.error;
        if (error) {
          settle(() => reject(new HerdrError(error.code ?? "error", error.message ?? "")));
          return;
        }
        settle(() => resolve(message.result as T));
      },
      (reason) => settle(() => reject(new Error(`${method}: ${reason}`))),
    );

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => reader.push(chunk));
    socket.on("error", (error) => settle(() => reject(error)));
    socket.on("close", () => {
      settle(() => reject(new Error(`${method}: connection closed before a response`)));
    });
  });
}

export type SubscriptionSpec = { type: string; [filter: string]: unknown };

export type SubscribeOptions = {
  events: readonly SubscriptionSpec[];
  onEvent: (event: string, data: unknown) => void;
  onLost: () => void;
  onStarted?: () => void;
  onError?: (error: Error) => void;
  path?: string;
  reconnectDelayMs?: number;
};

export function subscribe(options: SubscribeOptions): () => void {
  const { events, onEvent, onLost, onStarted, onError } = options;
  const path = options.path ?? socketPath();
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let stopped = false;
  let socket: net.Socket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lostNotified = false;

  const notifyLost = () => {
    if (lostNotified) return;
    lostNotified = true;
    onLost();
  };

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, reconnectDelayMs);
  };

  const connect = () => {
    if (stopped) return;
    lostNotified = false;

    const id = `hwc-sub-${++sequence}`;
    const current = net.connect(path);
    current.setEncoding("utf8");
    socket = current;

    const close = () => {
      if (socket === current) socket = null;
      current.destroy();
    };

    const reader = createLineReader(
      (line) => {
        const message = parseMessage(line);
        if (!message) return;

        const error = message.error;
        if (error) {
          const code = error.code ?? "error";
          if (code === "events_lost") {
            notifyLost();
            close();
            return;
          }
          // A rejected subscription would fail the same way on every retry, so stop instead of looping.
          stopped = true;
          onError?.(new HerdrError(code, error.message ?? ""));
          close();
          return;
        }

        if (message.result?.type === "subscription_started") {
          onStarted?.();
          return;
        }

        if (typeof message.event === "string") onEvent(message.event, message.data);
      },
      (reason) => {
        onError?.(new Error(`subscription: ${reason}`));
        close();
      },
    );

    current.on("connect", () => {
      current.write(
        `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: events } })}\n`,
      );
    });
    current.on("data", (chunk: string) => reader.push(chunk));
    current.on("error", (error) => {
      if (!stopped) onError?.(error);
    });
    current.on("close", () => {
      if (socket === current) socket = null;
      if (stopped) return;
      notifyLost();
      scheduleReconnect();
    });
  };

  connect();

  return () => {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    socket?.destroy();
    socket = null;
  };
}
