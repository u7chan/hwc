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
  forgetRecorded: (paneId: string, model: string | null) => void;
  read: (paneId: string, directory: string) => Promise<PiDefaultModel | null>;
};

// 既定モデルで起動したペインだけ、チャット画面を開いたときに既定を読む。起動時には
// 何も聞かない。同じペインの同時要求は 1 つに畳み、成功した値だけを預かる（ADR 0087）。
export function createPiDefaults(readDefaults: PiDefaultsReader = loadPiDefaults): PiDefaultsStore {
  const expected = new Set<string>();
  const resolved = new Map<string, PiDefaultModel>();
  const loading = new Map<string, Promise<PiDefaultModel>>();

  const forget = (paneId: string): void => {
    expected.delete(paneId);
    resolved.delete(paneId);
    loading.delete(paneId);
  };

  return {
    remember(paneId) {
      expected.add(paneId);
      resolved.delete(paneId);
      loading.delete(paneId);
    },
    forget,
    // 会話にモデルが載ったら、既定で補う理由が無くなる。閉じたペインの預かりも残さない。
    forgetRecorded(paneId, model) {
      if (model !== null) forget(paneId);
    },
    async read(paneId, directory) {
      if (!expected.has(paneId)) return null;
      const cached = resolved.get(paneId);
      if (cached !== undefined) return cached;
      let pending = loading.get(paneId);
      if (pending === undefined) {
        pending = readDefaults(directory).then(
          (value) => {
            loading.delete(paneId);
            // 解決中に閉じた・会話に載ったペインへ、後から値を預けない。
            if (expected.has(paneId)) resolved.set(paneId, value);
            return value;
          },
          (error) => {
            loading.delete(paneId);
            throw error;
          },
        );
        loading.set(paneId, pending);
      }
      return pending;
    },
  };
}
