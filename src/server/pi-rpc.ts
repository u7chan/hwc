// pi の RPC は 1 行 1 応答の JSON。表示用の問い合わせは、実セッションと同じく
// 拡張を読み込んだ一時プロセスで行い、終わったら必ず回収する。
export const PI_RPC_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type PiRpcOptions = {
  command?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  // 失敗をどの機能の失敗として返すか。呼び出し側の文言をそのまま使う。
  failure: string;
};

export function readPiRpcData(
  text: string,
  command: string,
  failure: string,
): Record<string, unknown> {
  const responses = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
  const response = responses.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "response" &&
      "command" in value &&
      value.command === command,
  ) as { success?: unknown; data?: unknown } | undefined;
  if (
    response?.success !== true ||
    typeof response.data !== "object" ||
    response.data === null ||
    Array.isArray(response.data)
  )
    throw new Error(failure);
  return response.data as Record<string, unknown>;
}

export async function runPiRpc(
  directory: string,
  args: string[],
  input: string,
  options: PiRpcOptions,
): Promise<string> {
  // HERDR_ を継ぐとペイン扱いになる。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  const child = Bun.spawn([...(options.command ?? ["pi"]), ...args], {
    cwd: directory,
    env: { ...env, NO_COLOR: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    timeout: options.timeoutMs ?? PI_RPC_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  try {
    child.stdin.write(input);
    child.stdin.end();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > (options.maxOutputBytes ?? MAX_OUTPUT_BYTES))
        throw new Error("Pi RPC output is too large");
      text += decoder.decode(value, { stream: true });
    }
    if ((await child.exited) !== 0) throw new Error(options.failure);
    return text + decoder.decode();
  } finally {
    // 一時セッションの拡張が終了処理で止まっても、調査プロセスを残さない。
    child.kill("SIGKILL");
    await child.exited;
  }
}
