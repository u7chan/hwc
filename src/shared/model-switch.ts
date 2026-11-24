import { type AgentModel, isAgentModel, isClaudeAlias } from "./agents";

// 実行中の Claude のモデルと effort を切り替える要求。モデルは起動時と同じエイリアスで、
// 両方を必ず持つ。モデルを変えると effort が黙って変わることがあるので、画面に見えていた
// 値を明示して送る（docs/adr/claude-integration.md）。
export type ModelSwitchRequest = { model: AgentModel; effort: string };

// 送る `/effort` の引数。コマンドの文字列に混ぜてよい形だけを通す。
const EFFORT_WORD = /^[a-z]{1,16}$/;

// 形の検査だけ。候補との照合は BFF が行う。
export function parseModelSwitchRequest(body: unknown): ModelSwitchRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { model, effort } = body as { model?: unknown; effort?: unknown };
  if (!isAgentModel(model) || model.provider !== "claude" || !isClaudeAlias(model.id)) return null;
  if (typeof effort !== "string" || !EFFORT_WORD.test(effort)) return null;
  return { model: { provider: model.provider, id: model.id }, effort };
}

// `opus` と `claude-opus-5-5` を同じ系統として比べるための名前。読めない id は null。
export function claudeModelFamily(id: string): string | null {
  if (isClaudeAlias(id)) return id;
  const family = /^claude-([a-z]+)-\d/.exec(id)?.[1];
  return family !== undefined && isClaudeAlias(family) ? family : null;
}

export type SwitchPlan = { model: boolean; effort: boolean };

// 何を送るか。モデルを変えるときは、effort を必ず明示する。CLI は、effort を指定していない
// セッションではモデルごとの保存値へ、指定済みならその値のままにするので、結果が
// 読めなくなる。系統が同じなら同じモデルとみなす（`opus` が最新版に進んだ場合は、
// 起動時に頼んだ版のままにする）。
export function modelSwitchPlan(
  current: { model: string | null; effort: string | null },
  request: ModelSwitchRequest,
): SwitchPlan {
  const family = current.model === null ? null : claudeModelFamily(current.model);
  const model = family === null || family !== request.model.id;
  return { model, effort: model || current.effort !== request.effort };
}

export function modelCommand(model: AgentModel): string {
  return `/model ${model.id}`;
}

export function effortCommand(effort: string): string {
  return `/effort ${effort}`;
}
