import {
  type AgentModel,
  isAgentEffort,
  isAgentModel,
  type ModelAgentKind,
  supportsModelSelection,
} from "./agents";

// 新しいペインの初期選択に使う、エージェントごとの既定。BFF が正で、設定画面だけが変える。
// effort が null なのは、保存したときのモデルが effort に対応していなかった場合だけ。
export type LaunchDefault = { model: AgentModel; effort: string | null };

export type LaunchDefaults = Partial<Record<ModelAgentKind, LaunchDefault>>;

export function parseLaunchDefault(value: unknown): LaunchDefault | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { model, effort } = value as { model?: unknown; effort?: unknown };
  if (!isAgentModel(model)) return null;
  if (effort !== null && !isAgentEffort(effort)) return null;
  return { model: { provider: model.provider, id: model.id }, effort };
}

// 未知のエージェント種別と壊れた値は、その分だけ捨てる。
export function parseLaunchDefaults(value: unknown): LaunchDefaults {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const defaults: LaunchDefaults = {};
  for (const [agent, raw] of Object.entries(value)) {
    if (!supportsModelSelection(agent)) continue;
    const parsed = parseLaunchDefault(raw);
    if (parsed !== null) defaults[agent] = parsed;
  }
  return defaults;
}
