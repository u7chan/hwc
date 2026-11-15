import { type AgentModel, isAgentEffort, isAgentModel, modelKey } from "../shared/agents";
import { readPiRpcData, runPiRpc } from "./pi-rpc";

export function parsePiEfforts(text: string, selected: AgentModel): string[] {
  const state = readPiRpcData(text, "get_state", "Pi effort is unavailable");
  const model = state.model;
  if (!isAgentModel(model) || modelKey(model) !== modelKey(selected))
    throw new Error("Pi did not select the requested model");
  const reasoning = (model as AgentModel & { reasoning?: unknown }).reasoning;
  if (typeof reasoning !== "boolean") throw new Error("Pi reasoning support is unavailable");
  const levels = readPiRpcData(
    text,
    "get_available_thinking_levels",
    "Pi thinking levels are unavailable",
  ).levels;
  if (!Array.isArray(levels) || !levels.every(isAgentEffort))
    throw new Error("Pi thinking levels are unavailable");
  return reasoning ? [...new Set(levels)] : [];
}

export async function loadPiEfforts(
  directory: string,
  model: AgentModel,
  options: { command?: string[]; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string[]> {
  // 対応段階の規則をコピーせず、実際の起動と同じモデル・拡張を一時セッションに読み込む。
  const text = await runPiRpc(
    directory,
    ["--offline", "--mode", "rpc", "--no-session", "--model", modelKey(model)],
    '{"type":"get_state"}\n{"type":"get_available_thinking_levels"}\n',
    {
      command: options.command,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      failure: "Pi effort lookup failed",
    },
  );
  return parsePiEfforts(text, model);
}
