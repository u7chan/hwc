import { useEffect, useState } from "preact/hooks";
import type { AgentModel, ModelAgentKind, ModelLabels } from "../shared/agents";
import { type AgentModelsRead, readAgentEfforts, readAgentModels, readModelLabels } from "./api";
import type { EffortCandidates, ModelCandidates } from "./launch-choice";

type Candidates<T> = { read: T; reload: () => void };

// 結果は読んだ条件と一緒に持つ。条件が変わった直後の描画で、前の条件の候補を
// 出さずに取得中として扱う。再取得は試行の番号を進めて条件を変える。
function useCandidates<T>(
  key: readonly unknown[] | null,
  load: (signal: AbortSignal) => Promise<T>,
): Candidates<T | undefined> {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; read: T }>();
  const current = key === null ? null : JSON.stringify([...key, attempt]);

  useEffect(() => {
    if (current === null) return;
    const controller = new AbortController();
    void load(controller.signal).then((read) => {
      if (!controller.signal.aborted) setResult({ key: current, read });
    });
    return () => controller.abort();
    // load は描画ごとに作り直される。何を読むかは current がすべて表すので、load は
    // 依存に入れない。
  }, [current]);

  return {
    read: result !== undefined && result.key === current ? result.read : undefined,
    reload: () => setAttempt((value) => value + 1),
  };
}

// paneId が null なら設定画面の候補で、BFF がホームディレクトリで読む。
export function useModelCandidates(
  paneId: string | null,
  agent: ModelAgentKind,
): Candidates<ModelCandidates> {
  return useCandidates<AgentModelsRead>([paneId, agent], (signal) =>
    readAgentModels(paneId, agent, signal),
  );
}

// 候補は alias のまま返し、表示だけを後から差し替える。読めなければ alias のまま。
export function useModelLabels(enabled: boolean): ModelLabels | null {
  const [labels, setLabels] = useState<ModelLabels | null>(null);

  useEffect(() => {
    setLabels(null);
    if (!enabled) return;
    const controller = new AbortController();
    void readModelLabels(controller.signal).then((read) => {
      if (!controller.signal.aborted) setLabels(read);
    });
    return () => controller.abort();
  }, [enabled]);

  return labels;
}

// effort の候補はモデルごとに違う。モデルが決まるまでは読まない。
export function useEffortCandidates(
  paneId: string | null,
  agent: ModelAgentKind,
  model: AgentModel | null,
): Candidates<EffortCandidates> {
  return useCandidates<string[] | null>(
    model === null ? null : [paneId, agent, model.provider, model.id],
    (signal) =>
      model === null ? Promise.resolve(null) : readAgentEfforts(paneId, agent, model, signal),
  );
}
