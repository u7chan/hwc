import {
  type AgentModel,
  type ModelAgentKind,
  isAgentEffort,
  isAgentModel,
  modelKey,
} from "../shared/agents";
import { readServiceFile, requestJson } from "./chat/opencode";
import { asRecord, type CodexReader, nextCursor, withCodex } from "./codex";
import { loadPiEfforts } from "./pi-efforts";

export type AgentModelsClient = {
  list: (agent: ModelAgentKind, directory: string) => Promise<AgentModel[]>;
  efforts: (agent: ModelAgentKind, model: AgentModel, directory: string) => Promise<string[]>;
  startArgs: (
    agent: ModelAgentKind,
    model: AgentModel,
    directory: string,
    effort?: string | null,
  ) => Promise<string[]>;
};

export const MODEL_LIST_TIMEOUT_MS = 20_000;

// Claude Code 2.1.327 の `--model` は family のエイリアスを受け、その時点の最新モデルへ
// 解決する。hwc は版を追わず、エイリアスだけを候補にする。`fable` / `opus` / `sonnet` は
// `claude --help`、`haiku` は CLI 同梱の alias 一覧で確認した（ADR 0096）。
const CLAUDE_PROVIDER = "claude";
const CLAUDE_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;
// `claude --help` の `--effort` が示す段階。エイリアスの解決先はすべてこの 5 段階に対応する。
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function claudeModels(): AgentModel[] {
  return CLAUDE_MODEL_ALIASES.map((id) => ({ provider: CLAUDE_PROVIDER, id }));
}

export function parsePiModels(text: string): AgentModel[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.findIndex((line) =>
    /^provider\s+model\s+context\s+max-out\s+thinking\s+images\s*$/.test(line),
  );
  if (header < 0) {
    if (text.includes("No models available")) return [];
    throw new Error("Pi model list is not available");
  }
  const models: AgentModel[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === "") continue;
    const [provider, id, context, maxOut, thinking, images, extra] = line.trim().split(/\s+/);
    const model = { provider, id };
    if (
      !isAgentModel(model) ||
      !context ||
      !maxOut ||
      !/^(yes|no)$/.test(thinking ?? "") ||
      !/^(yes|no)$/.test(images ?? "") ||
      extra !== undefined
    ) {
      throw new Error("Pi model list is invalid");
    }
    models.push(model);
  }
  return uniqueModels(models);
}

export function parseOpencodeModels(raw: unknown): AgentModel[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("OpenCode model list is not available");
  const models: AgentModel[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null || item.enabled !== true) continue;
    const model = { provider: item.providerID, id: item.id };
    if (isAgentModel(model)) models.push(model);
  }
  return uniqueModels(models);
}

function uniqueModels<T extends AgentModel>(models: T[]): T[] {
  return [...new Map(models.map((model) => [modelKey(model), model])).values()].sort((a, b) =>
    modelKey(a).localeCompare(modelKey(b)),
  );
}

async function listPiModels(directory: string): Promise<string> {
  // HERDR_ を継ぐとペイン扱いになる。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  const child = Bun.spawn(["pi", "--offline", "--list-models"], {
    cwd: directory,
    env: { ...env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: MODEL_LIST_TIMEOUT_MS,
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("Pi model list failed");
  return text;
}

export function createAgentModelsClient(
  options: {
    servicePath?: string;
    piModels?: (directory: string) => Promise<string>;
    piEfforts?: typeof loadPiEfforts;
    request?: typeof requestJson;
    loadService?: typeof readServiceFile;
    codex?: CodexReader;
  } = {},
): AgentModelsClient {
  const piModels = options.piModels ?? listPiModels;
  const request = options.request ?? requestJson;
  const loadService = () => (options.loadService ?? readServiceFile)(options.servicePath);
  const codex = options.codex ?? withCodex;
  const piEfforts = options.piEfforts ?? loadPiEfforts;

  const list: AgentModelsClient["list"] = async (agent, directory) => {
    if (agent === "claude") return claudeModels();
    if (agent === "pi") return parsePiModels(await piModels(directory));
    if (agent === "codex")
      return (await listCodexModels(codex, directory)).map(({ provider, id }) => ({
        provider,
        id,
      }));
    const service = await loadService();
    const query = new URLSearchParams({ "location[directory]": directory });
    return parseOpencodeModels(await request(service, `/api/model?${query}`, 5_000));
  };

  const efforts: AgentModelsClient["efforts"] = async (agent, model, directory) => {
    if (agent === "claude") {
      const available = claudeModels();
      if (!available.some((candidate) => modelKey(candidate) === modelKey(model)))
        throw new Error("Claude effort is unavailable");
      return [...CLAUDE_EFFORTS];
    }
    if (agent === "pi") return piEfforts(directory, model);
    if (agent === "codex") {
      const available = await listCodexModels(codex, directory);
      const selected = available.find((candidate) => modelKey(candidate) === modelKey(model));
      const values = selected?.supportedReasoningEfforts;
      if (!Array.isArray(values)) throw new Error("Codex effort is unavailable");
      return effortValues(values.map((value) => asRecord(value)?.reasoningEffort));
    }
    const service = await loadService();
    const query = new URLSearchParams({ "location[directory]": directory });
    const raw = asRecord(await request(service, `/api/model?${query}`, 5_000));
    if (!Array.isArray(raw?.data)) throw new Error("OpenCode model list is not available");
    const selected = raw.data
      .map(asRecord)
      .find(
        (candidate) =>
          candidate?.enabled === true &&
          candidate.providerID === model.provider &&
          candidate.id === model.id,
      );
    if (!Array.isArray(selected?.variants)) throw new Error("OpenCode variants are unavailable");
    return effortValues(selected.variants.map((value: unknown) => asRecord(value)?.id));
  };

  return {
    list,
    efforts,
    async startArgs(agent, model, directory, effort = null) {
      const available = await list(agent, directory);
      if (!available.some((candidate) => modelKey(candidate) === modelKey(model))) {
        throw new Error("The selected model is not available");
      }
      if (effort !== null && !(await efforts(agent, model, directory)).includes(effort))
        throw new Error("The selected effort is not available");
      if (agent === "claude")
        return ["--model", model.id, ...(effort === null ? [] : ["--effort", effort])];
      if (agent === "pi")
        return ["--model", modelKey(model), ...(effort === null ? [] : ["--thinking", effort])];
      if (agent === "codex")
        return [
          "--model",
          model.id,
          ...(effort === null
            ? []
            : ["--config", `model_reasoning_effort=${JSON.stringify(effort)}`]),
        ];

      // OpenCode 2 の通常 TUI に --model は無い。新規セッションだけにモデルを指定し、
      // --session で開く。共有の既定設定や実行中のセッションには触れない。
      const service = await loadService();
      const raw = await request(service, "/api/session", 5_000, {
        model: {
          providerID: model.provider,
          id: model.id,
          ...(effort === null ? {} : { variant: effort }),
        },
        location: { directory },
      });
      const id = (raw as { data?: { id?: unknown } } | null)?.data?.id;
      if (typeof id !== "string" || !/^ses_[a-zA-Z0-9_-]+$/.test(id)) {
        throw new Error("OpenCode did not create a session");
      }
      return ["--session", id];
    },
  };
}

function effortValues(values: unknown[]): string[] {
  if (!values.every(isAgentEffort)) throw new Error("Effort values are invalid");
  return [...new Set(values)];
}

async function listCodexModels(
  read: CodexReader,
  directory: string,
): Promise<(AgentModel & { supportedReasoningEfforts?: unknown })[]> {
  return read(directory, async (request) => {
    const raw = await request("config/read", { cwd: directory, includeLayers: false });
    const config = asRecord(asRecord(raw)?.config);
    if (config === null) throw new Error("Codex config is not available");
    const provider = config.model_provider ?? "openai";
    const models: (AgentModel & { supportedReasoningEfforts?: unknown })[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      const result = asRecord(
        await request("model/list", {
          includeHidden: false,
          limit: 100,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      if (!Array.isArray(result?.data)) throw new Error("Codex model list is not available");
      for (const item of result.data) {
        const record = asRecord(item);
        const model = { provider, id: record?.model };
        if (record?.hidden !== true && isAgentModel(model))
          models.push({ ...model, supportedReasoningEfforts: record?.supportedReasoningEfforts });
      }
      cursor = nextCursor(result);
      if (cursor === null) return uniqueModels(models);
      if (seen.has(cursor)) throw new Error("Codex cursor did not advance");
      seen.add(cursor);
    }
    throw new Error("Codex model list is too large");
  });
}
