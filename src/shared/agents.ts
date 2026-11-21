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

// 表示だけに使う解決済みの名前。キーは `modelKey`。保存する既定には含めない。
export type ModelLabels = Record<string, string>;

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

// Claude Code 2.1.327 の `--model` は family のエイリアスを受け、その時点の最新モデルへ
// 解決する。hwc は版を追わず、エイリアスだけを候補にする。`fable` / `opus` / `sonnet` は
// `claude --help`、`haiku` は CLI 同梱の alias 一覧で確認した（ADR 0096）。
export const CLAUDE_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

export function isClaudeAlias(id: string): boolean {
  return (CLAUDE_MODEL_ALIASES as readonly string[]).includes(id);
}

// エイリアスは `Opus`、`claude-opus-5-5` は `Opus 5.5` にする。版は id に含まれるので、
// リリースごとの対応表は持たない。minor を 1〜2 桁に絞るのは、`claude-opus-4-20250514` の
// 日付を minor と読まないため。読めない id（旧形式、他プロバイダーの id）はそのまま返す。
export function claudeModelName(id: string): string {
  const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  const [, family, major, minor] = /^claude-([a-z]+)-(\d+)-(\d{1,2})(?:-\d{8})?$/.exec(id) ?? [];
  if (family !== undefined) return `${capitalize(family)} ${major}.${minor}`;
  return isClaudeAlias(id) ? capitalize(id) : id;
}

// エージェント名と並べて出すときの名前。Claude は provider が常に `claude` なので表示名だけに
// し、エイリアスは `Opus` のように社名を冠さない。Codex / OpenCode の provider（`openai` /
// `opencode-go`）も選んだエージェントと同じで、行の「Codex  openai/gpt-6.1-sol」のように自分を
// 二重に名乗るので、モデル id だけにする。Pi だけは `opencode-go/…` のように provider が
// 選択の一部なので残す。
export function modelLabel(
  agent: ModelAgentKind,
  model: AgentModel,
  labels: ModelLabels | null = null,
): string {
  if (agent === "claude") {
    const label = labels?.[modelKey(model)];
    if (label !== undefined && label !== "") return label;
    return claudeModelName(model.id);
  }
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
