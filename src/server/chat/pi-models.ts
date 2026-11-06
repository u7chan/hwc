import { isAgentModel } from "../../shared/agents";

export type PiModelWindow = { provider: string; id: string; window: number };

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function parsePiModelWindows(text: string): PiModelWindow[] {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== "object" || raw === null) continue;
    const response = raw as { command?: unknown; success?: unknown; data?: { models?: unknown } };
    if (response.command !== "get_available_models") continue;
    if (response.success !== true || !Array.isArray(response.data?.models)) break;
    return response.data.models.flatMap((item: unknown) => {
      if (typeof item !== "object" || item === null) return [];
      const model = item as { provider?: unknown; id?: unknown; contextWindow?: unknown };
      const window = model.contextWindow;
      if (
        !isAgentModel(model) ||
        typeof window !== "number" ||
        !Number.isFinite(window) ||
        window <= 0
      )
        return [];
      return [{ provider: model.provider, id: model.id, window }];
    });
  }
  throw new Error("Pi model catalog is unavailable");
}

export async function loadPiModelWindows(agentDir: string): Promise<PiModelWindow[]> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  const child = Bun.spawn(["pi", "--offline", "--mode", "rpc", "--no-session", "--no-extensions"], {
    cwd: agentDir,
    env: { ...env, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 8_000,
  });
  try {
    child.stdin.write('{"type":"get_available_models"}\n');
    child.stdin.end();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OUTPUT_BYTES) throw new Error("Pi model catalog is too large");
      text += decoder.decode(value, { stream: true });
    }
    if ((await child.exited) !== 0) throw new Error("Pi model catalog failed");
    return parsePiModelWindows(text + decoder.decode());
  } finally {
    child.kill();
    await child.exited;
  }
}
