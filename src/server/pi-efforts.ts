import { type AgentModel, isAgentEffort, isAgentModel, modelKey } from "../shared/agents";

export const PI_EFFORT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function parsePiEfforts(text: string, selected: AgentModel): string[] {
  const responses = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
  const dataFor = (command: string): Record<string, unknown> => {
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
      throw new Error("Pi effort is unavailable");
    return response.data as Record<string, unknown>;
  };
  const model = dataFor("get_state").model;
  if (!isAgentModel(model) || modelKey(model) !== modelKey(selected))
    throw new Error("Pi did not select the requested model");
  const reasoning = (model as AgentModel & { reasoning?: unknown }).reasoning;
  if (typeof reasoning !== "boolean") throw new Error("Pi reasoning support is unavailable");
  const levels = dataFor("get_available_thinking_levels").levels;
  if (!Array.isArray(levels) || !levels.every(isAgentEffort))
    throw new Error("Pi thinking levels are unavailable");
  return reasoning ? [...new Set(levels)] : [];
}

export async function loadPiEfforts(
  directory: string,
  model: AgentModel,
  options: { command?: string[]; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string[]> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  // 対応段階の規則をコピーせず、実際の起動と同じモデル・拡張を一時セッションに読み込む。
  const child = Bun.spawn(
    [
      ...(options.command ?? ["pi"]),
      "--offline",
      "--mode",
      "rpc",
      "--no-session",
      "--model",
      modelKey(model),
    ],
    {
      cwd: directory,
      env: { ...env, NO_COLOR: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      timeout: options.timeoutMs ?? PI_EFFORT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  try {
    child.stdin.write('{"type":"get_state"}\n{"type":"get_available_thinking_levels"}\n');
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
        throw new Error("Pi effort response is too large");
      text += decoder.decode(value, { stream: true });
    }
    if ((await child.exited) !== 0) throw new Error("Pi effort lookup failed");
    return parsePiEfforts(text + decoder.decode(), model);
  } finally {
    // 一時セッションの拡張が終了処理で止まっても、調査プロセスを残さない。
    child.kill("SIGKILL");
    await child.exited;
  }
}
