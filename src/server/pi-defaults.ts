import { isAgentEffort, isAgentModel } from "../shared/agents";
import { readPiRpcData, runPiRpc } from "./pi-rpc";

export type PiDefaultModel = { model: string; effort: string | null };

export type PiDefaultsReader = (directory: string) => Promise<PiDefaultModel>;

export function parsePiDefaults(text: string): PiDefaultModel {
  const state = readPiRpcData(text, "get_state", "Pi default model is unavailable");
  const model = state.model;
  if (!isAgentModel(model)) throw new Error("Pi default model is unavailable");
  const thinking = state.thinkingLevel;
  const reasoning = (model as { reasoning?: unknown }).reasoning;
  return {
    model: model.id,
    // 推論しないモデルに effort は無い。読めない段階は不明として出さない。
    effort: reasoning === false || !isAgentEffort(thinking) ? null : thinking,
  };
}

export async function loadPiDefaults(
  directory: string,
  options: { command?: string[]; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<PiDefaultModel> {
  // 実際の起動と同じ既定解決を使う。モデルは指定せず、pi に既定を選ばせる。
  const text = await runPiRpc(
    directory,
    ["--offline", "--mode", "rpc", "--no-session"],
    '{"type":"get_state"}\n',
    {
      command: options.command,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      failure: "Pi default model lookup failed",
    },
  );
  return parsePiDefaults(text);
}

export type PiDefaultsStore = {
  remember: (paneId: string) => void;
  forget: (paneId: string) => void;
  dropResolved: (paneId: string, model: string | null) => void;
  read: (paneId: string, directory: string) => Promise<PiDefaultModel | null>;
};

// 既定モデルで起動したペインだけ、チャット画面を開いたときと、/new でセッションが
// 空に戻ったときに既定を読む。起動時には何も聞かない。同じペインの同時要求は 1 つに
// 畳み、成功した値だけを預かる（ADR 0087・0091）。
export function createPiDefaults(readDefaults: PiDefaultsReader = loadPiDefaults): PiDefaultsStore {
  // ペイン id ごとの起動世代。値と解決中の問い合わせは、この世代に属するものだけを
  // 有効にする。/exit して同じペインで起動し直したとき、前の問い合わせが遅れて返っても
  // 新しい起動の値は変えない。
  let nextGeneration = 0;
  const expected = new Map<string, number>();
  const resolved = new Map<string, { generation: number; value: PiDefaultModel }>();
  const loading = new Map<string, { generation: number; promise: Promise<PiDefaultModel> }>();

  const forget = (paneId: string): void => {
    expected.delete(paneId);
    resolved.delete(paneId);
    loading.delete(paneId);
  };

  return {
    remember(paneId) {
      expected.set(paneId, ++nextGeneration);
      resolved.delete(paneId);
      loading.delete(paneId);
    },
    forget,
    // 会話にモデルが載ったら、解決済みの値は捨てる。既定で起動した記録は残すので、
    // /new でセッションが空に戻ったときに、その時点の既定を取り直せる（ADR 0091）。
    dropResolved(paneId, model) {
      if (model !== null) resolved.delete(paneId);
    },
    async read(paneId, directory) {
      const generation = expected.get(paneId);
      if (generation === undefined) return null;
      const cached = resolved.get(paneId);
      if (cached !== undefined && cached.generation === generation) return cached.value;
      const pending = loading.get(paneId);
      if (pending !== undefined && pending.generation === generation) return pending.promise;

      let promise: Promise<PiDefaultModel>;
      promise = readDefaults(directory).then(
        (value) => {
          // 解決中に終了・再起動した場合、前の世代の値は預けない。loading も新しい
          // 世代のものと取り違えないよう、自分の登録だけを消す。
          if (expected.get(paneId) === generation) {
            resolved.set(paneId, { generation, value });
            if (loading.get(paneId)?.promise === promise) loading.delete(paneId);
          }
          return value;
        },
        (error) => {
          if (loading.get(paneId)?.promise === promise) loading.delete(paneId);
          throw error;
        },
      );
      loading.set(paneId, { generation, promise });
      return promise;
    },
  };
}
