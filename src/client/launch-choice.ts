import { type AgentModel, modelKey } from "../shared/agents";
import type { LaunchDefault } from "../shared/launch-defaults";
import type { AgentModelsRead } from "./api";

// 候補の読み取り。undefined は取得中、null は取得失敗。
export type ModelCandidates = AgentModelsRead | undefined;
export type EffortCandidates = string[] | null | undefined;

export function sameModel(a: AgentModel, b: AgentModel): boolean {
  return modelKey(a) === modelKey(b);
}

// CLI の既定には任せない（ADR 0104）。選んだモデル、無ければ既定のモデルを、どちらも
// いまの候補にあるときだけ使う。既定の読み出しが遅れて届いても、選んだ値を上書きしない。
export function chooseModel(
  candidates: ModelCandidates,
  saved: LaunchDefault | null,
  chosen: AgentModel | null,
): AgentModel | null {
  if (!Array.isArray(candidates)) return null;
  const pick = (model: AgentModel | null | undefined) =>
    model == null ? null : (candidates.find((candidate) => sameModel(candidate, model)) ?? null);
  return pick(chosen) ?? pick(saved?.model);
}

// 既定の effort は、選択中のモデルが既定のモデルのときだけ使う。別のモデルへ持ち越すと、
// 選んでいない値で起動する。
export function chooseEffort(
  candidates: EffortCandidates,
  model: AgentModel | null,
  saved: LaunchDefault | null,
  chosen: string | null,
): string | null {
  if (model === null || !Array.isArray(candidates)) return null;
  const pick = (effort: string | null | undefined) =>
    effort != null && candidates.includes(effort) ? effort : null;
  return pick(chosen) ?? pick(savedEffortFor(model, saved));
}

// 選択肢に「（既定）」を添えるための値。既定のモデルを選んでいないときは null。
export function savedEffortFor(
  model: AgentModel | null,
  saved: LaunchDefault | null,
): string | null {
  if (model === null || saved === null || !sameModel(model, saved.model)) return null;
  return saved.effort;
}

// effort に対応するモデル（候補が 1 件以上）は effort も選ぶまで起動しない。対応しない
// モデル（候補が空）は effort なしで起動する。候補を読めていない間と失敗は起動しない。
export function canLaunch(
  model: AgentModel | null,
  efforts: EffortCandidates,
  effort: string | null,
): boolean {
  if (model === null || !Array.isArray(efforts)) return false;
  return efforts.length === 0 || effort !== null;
}
