import { type AgentModel, type ModelAgentKind, isAgentModel, modelKey } from "../shared/agents";
import { readServiceFile, requestJson } from "./chat/opencode";

export type AgentModelsClient = {
  list: (agent: ModelAgentKind, directory: string) => Promise<AgentModel[]>;
  startArgs: (agent: ModelAgentKind, model: AgentModel, directory: string) => Promise<string[]>;
};

export const MODEL_LIST_TIMEOUT_MS = 20_000;

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

function uniqueModels(models: AgentModel[]): AgentModel[] {
  return [...new Map(models.map((model) => [modelKey(model), model])).values()].sort((a, b) =>
    modelKey(a).localeCompare(modelKey(b)),
  );
}

async function listPiModels(directory: string): Promise<string> {
  // 調査用プロセスが呼び出し元のペインを自分のものとして報告しないようにする。
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
    request?: typeof requestJson;
    loadService?: typeof readServiceFile;
  } = {},
): AgentModelsClient {
  const piModels = options.piModels ?? listPiModels;
  const request = options.request ?? requestJson;
  const loadService = () => (options.loadService ?? readServiceFile)(options.servicePath);

  const list: AgentModelsClient["list"] = async (agent, directory) => {
    if (agent === "pi") return parsePiModels(await piModels(directory));
    const service = await loadService();
    const query = new URLSearchParams({ "location[directory]": directory });
    return parseOpencodeModels(await request(service, `/api/model?${query}`, 5_000));
  };

  return {
    list,
    async startArgs(agent, model, directory) {
      const available = await list(agent, directory);
      if (!available.some((candidate) => modelKey(candidate) === modelKey(model))) {
        throw new Error("The selected model is not available");
      }
      if (agent === "pi") return ["--model", modelKey(model)];

      // OpenCode 2 の通常 TUI に --model は無い。新規セッションだけにモデルを指定し、
      // --session で開く。共有の既定設定や実行中のセッションには触れない。
      const service = await loadService();
      const raw = await request(service, "/api/session", 5_000, {
        model: { providerID: model.provider, id: model.id },
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
