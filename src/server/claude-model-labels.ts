import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { type ModelLabels, claudeModelName, isClaudeAlias, modelKey } from "../shared/agents";

export const CLAUDE_LABELS_TTL_MS = 5 * 60_000;
export const CLAUDE_LABELS_FAILURE_TTL_MS = 30_000;
export const CLAUDE_LABELS_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type ClaudeModelLabelsReader = {
  read: () => Promise<ModelLabels | null>;
};

export type ClaudeModelLabelsOptions = {
  command?: string;
  homeDirectory?: string;
  timeoutMs?: number;
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
  run?: () => Promise<string>;
  key?: () => Promise<string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function labelText(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 64 && !/\p{Cc}/u.test(value)
    ? value
    : null;
}

// `list_models` の control_response から、hwc が候補に出している alias だけを拾う。
// `value` には版付きの id も混ざるが、候補を増やさないため alias 以外は捨てる。
export function parseClaudeModelLabels(output: string): ModelLabels | null {
  let found = false;
  const labels: ModelLabels = {};
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(message);
    if (record?.type !== "control_response") continue;
    const response = asRecord(record.response);
    const payload = asRecord(response?.response);
    const models = payload?.models;
    if (!Array.isArray(models)) continue;
    found = true;
    for (const item of models) {
      const model = asRecord(item);
      const value = model?.value;
      if (typeof value !== "string" || !isClaudeAlias(value)) continue;
      const displayName = labelText(model?.displayName);
      const resolvedModel = model?.resolvedModel;
      const derived =
        typeof resolvedModel === "string" ? claudeModelName(resolvedModel) : resolvedModel;
      // displayName が版を持たない版の CLI では、解決先の id から版を作る。
      const label =
        displayName !== null && /\d/.test(displayName)
          ? displayName
          : typeof derived === "string" && derived !== resolvedModel
            ? derived
            : null;
      if (label !== null) labels[modelKey({ provider: "claude", id: value })] = label;
    }
  }
  return found ? labels : null;
}

async function runClaudeListModels(options: ClaudeModelLabelsOptions): Promise<string> {
  // HERDR_ を継ぐとペイン扱いになる。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  const child = Bun.spawn(
    [
      options.command ?? "claude",
      "--safe-mode",
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
    ],
    {
      cwd: options.homeDirectory ?? homedir(),
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      timeout: options.timeoutMs ?? CLAUDE_LABELS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  try {
    child.stdin.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: "model-labels",
        request: { subtype: "list_models" },
      })}\n`,
    );
    child.stdin.end();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OUTPUT_BYTES) throw new Error("Claude model labels are too large");
      text += decoder.decode(value, { stream: true });
    }
    if ((await child.exited) !== 0) throw new Error("Claude model labels failed");
    return text + decoder.decode();
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function binaryKey(command: string): Promise<string> {
  try {
    const path = Bun.which(command);
    if (path === null) return "missing";
    const resolved = await realpath(path);
    const info = await stat(resolved);
    return `${resolved}:${info.mtimeMs}:${info.size}`;
  } catch {
    return "unknown";
  }
}

// 表示だけの派生値なので、ディスクには残さない。CLI が更新されたら binary の
// realpath / mtime で即座に捨て、カタログだけが更新された場合は TTL で拾う。
export function createClaudeModelLabels(
  options: ClaudeModelLabelsOptions = {},
): ClaudeModelLabelsReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CLAUDE_LABELS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? CLAUDE_LABELS_FAILURE_TTL_MS;
  const run = options.run ?? (() => runClaudeListModels(options));
  const readKey = options.key ?? (() => binaryKey(options.command ?? "claude"));
  let cache: { key: string; at: number; labels: ModelLabels | null; ttlMs: number } | null = null;
  let inFlight: Promise<ModelLabels | null> | null = null;

  return {
    async read() {
      const key = await readKey().catch(() => "unknown");
      const at = now();
      if (cache !== null && cache.key === key && at - cache.at < cache.ttlMs) {
        return cache.labels;
      }
      if (inFlight !== null) return inFlight;
      inFlight = (async () => {
        try {
          const labels = parseClaudeModelLabels(await run());
          if (labels === null) throw new Error("Claude model labels are unavailable");
          cache = { key, at: now(), labels, ttlMs };
          return labels;
        } catch {
          cache = { key, at: now(), labels: null, ttlMs: failureTtlMs };
          return null;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}
