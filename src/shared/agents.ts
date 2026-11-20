// 作成ダイアログの並び順と、BFF が受け付ける kind を 1 か所で決める。
// エージェントの追加はこの配列に足し、クライアントのアイコンだけ対応させる。
export const AGENT_KINDS = ["pi", "claude", "codex", "opencode"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

// hwc が会話を読めるエージェント。
export type ChatAgentKind = "pi" | "claude" | "codex" | "opencode";

// 起動時にモデルと effort を選べるエージェント。4 つの CLI はどれも `--model` / `--effort`
// 相当を受け取れる（ADR 0096）。
export type ModelAgentKind = ChatAgentKind;

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
  return agent === "pi" || agent === "claude" || agent === "codex" || agent === "opencode";
}

// hwc が起動したときに会話を読める見込みがあるエージェント。起動直後はセッションが
// できるまで pane.chat が false のままになる。
export function supportsChat(agent: unknown): agent is ChatAgentKind {
  return agent === "pi" || agent === "claude" || agent === "codex" || agent === "opencode";
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

// エージェント名と並べて出すときの名前。Claude の provider は常に `claude` で、行の
// 「Claude  claude/opus」のように自分を二重に名乗ってしまうので、provider を削ってモデルだけにする。
// Pi だけは `opencode-go/…` のように provider が選択の一部なので残す。
export function modelLabel(agent: ModelAgentKind, model: AgentModel): string {
  return agent === "pi" ? modelKey(model) : model.id;
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
