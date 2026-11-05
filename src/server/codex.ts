import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { ChatUnavailableError } from "./chat/errors";

export type CodexRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type CodexReader = <T>(
  directory: string | undefined,
  read: (request: CodexRequest) => Promise<T>,
) => Promise<T>;

export async function withCodex<T>(
  directory: string | undefined,
  read: (request: CodexRequest) => Promise<T>,
  options: { command?: string[]; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<T> {
  const [command, ...args] = options.command ?? ["codex", "app-server", "--stdio"];
  if (!command) throw new ChatUnavailableError("codex command is missing");
  // 読み取り専用のプロセスを、呼び出し元の Herdr ペインや Codex スレッドに結び付けない。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("HERDR_") && key !== "CODEX_THREAD_ID",
    ),
  );
  const child = spawn(command, args, { cwd: directory, env, stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let failure: Error | null = null;
  let bytes = 0;
  let sequence = 0;
  child.on("error", () => {
    failure = new ChatUnavailableError("codex could not start");
  });
  child.stdin.on("error", () => {
    // 起動失敗や終了時の EPIPE は stdout の終了と合わせて要求側へ返す。
  });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxOutputBytes ?? 32 * 1024 * 1024)) {
      failure = new ChatUnavailableError("codex response is too large");
      child.kill("SIGKILL");
    }
  });
  const timer = setTimeout(() => {
    failure = new ChatUnavailableError("codex did not answer");
    child.kill("SIGKILL");
  }, options.timeoutMs ?? 20_000);

  const request: CodexRequest = async (method, params) => {
    const id = ++sequence;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    while (true) {
      const next = await iterator.next();
      if (failure) throw failure;
      if (next.done) throw new ChatUnavailableError("codex closed the connection");
      let raw: unknown;
      try {
        raw = JSON.parse(next.value);
      } catch {
        throw new ChatUnavailableError("codex returned invalid json");
      }
      const response = asRecord(raw);
      if (response === null) throw new ChatUnavailableError("codex returned an invalid response");
      // 読み取り中の通知は購読しない。初期化や非推奨 API の通知が応答に先行することがある。
      if (response.id !== id) continue;
      if ("error" in response || !("result" in response)) {
        throw new ChatUnavailableError("codex request failed");
      }
      return response.result;
    }
  };

  try {
    await once(child, "spawn");
    await request("initialize", { clientInfo: { name: "hwc", version: "1" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await read(request);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.destroy();
    child.kill("SIGKILL");
    await exited;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nextCursor(result: Record<string, unknown>): string | null {
  const cursor = result.nextCursor;
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || cursor === "") {
    throw new ChatUnavailableError("codex cursor is invalid");
  }
  return cursor;
}
