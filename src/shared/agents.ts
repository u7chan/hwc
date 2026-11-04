// 作成ダイアログの並び順と、BFF が受け付ける kind を 1 か所で決める。
// エージェントの追加はこの配列に足し、クライアントのアイコンだけ対応させる。
export const AGENT_KINDS = ["pi", "claude", "codex", "opencode"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_LABELS: Record<AgentKind, string> = {
  pi: "Pi",
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}
