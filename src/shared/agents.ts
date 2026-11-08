// 作成ダイアログの並び順と、BFF が受け付ける kind を 1 か所で決める。
// エージェントの追加はこの配列に足し、クライアントのアイコンだけ対応させる。
export const AGENT_KINDS = ["pi", "claude", "codex", "opencode"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export type ModelAgentKind = "pi" | "codex" | "opencode";

export type AgentModel = { provider: string; id: string };

export function isAgentEffort(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 128 &&
    !/\p{Cc}/u.test(value)
  );
}

export function supportsModelSelection(agent: unknown): agent is ModelAgentKind {
  return agent === "pi" || agent === "codex" || agent === "opencode";
}

// 起動時に、既知のフォルダ信頼確認で止まるエージェント。
export type FolderTrustAgent = "pi" | "codex";

export function supportsFolderTrust(agent: unknown): agent is FolderTrustAgent {
  return agent === "pi" || agent === "codex";
}

export function isAgentModel(value: unknown): value is AgentModel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { provider, id } = value as Partial<AgentModel>;
  return (
    typeof provider === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider) &&
    typeof id === "string" &&
    /^[a-zA-Z0-9@][a-zA-Z0-9@._/:+-]{0,511}$/.test(id)
  );
}

export function modelKey(model: AgentModel): string {
  return `${model.provider}/${model.id}`;
}

export const AGENT_LABELS: Record<AgentKind, string> = {
  pi: "Pi",
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}
