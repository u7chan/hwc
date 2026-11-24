import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { asRecord, nonEmptyText } from "../../shared/json";
import { finiteNumber } from "./pi-entry";
import type { PiModelWindow } from "./pi-models";

const MODELS_STORE = "models-store.json";
const MODELS_CONFIG = "models.json";

type ModelCatalog = {
  contextWindow: (provider: string, model: string) => number | null | undefined;
};

export type WindowResolver = (
  sessionPath: string,
  provider: string | null,
  model: string | null,
) => Promise<number | null>;

export function createWindowResolver(
  readCatalogFile: (path: string) => Promise<string>,
  loadPiModels: (agentDir: string) => Promise<PiModelWindow[]>,
): WindowResolver {
  type FileValue = { version: string | null; value: unknown };
  const files = new Map<string, { version: string; value: unknown }>();
  const catalogs = new Map<
    string,
    { store: FileValue; config: FileValue; catalog: ModelCatalog }
  >();
  const running = new Map<string, Promise<ModelCatalog>>();
  const fallback = new Map<string, { catalog: ModelCatalog; pending: Promise<PiModelWindow[]> }>();

  const readJson = async (path: string): Promise<FileValue> => {
    let version: string | null = null;
    try {
      const info = await stat(path, { bigint: true });
      if (!info.isFile()) {
        files.delete(path);
        return { version, value: null };
      }
      // 同サイズの上書きと atomic rename も拾う。時刻は丸めずに比較する。
      version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const cached = files.get(path);
      if (cached?.version === version) return cached;
      const value: unknown = JSON.parse(await readCatalogFile(path));
      files.set(path, { version, value });
      return { version, value };
    } catch {
      // 失敗を覚えると、メタデータが同じまま読み取りが復旧しても再試行できない。
      files.delete(path);
      return { version, value: null };
    }
  };

  const catalogFor = (agentDir: string): Promise<ModelCatalog> => {
    const inFlight = running.get(agentDir);
    if (inFlight) return inFlight;

    const pending = Promise.all([
      readJson(join(agentDir, MODELS_STORE)),
      readJson(join(agentDir, MODELS_CONFIG)),
    ])
      .then(([store, config]) => {
        const cached = catalogs.get(agentDir);
        if (
          cached &&
          cached.store.value === store.value &&
          cached.store.version === store.version &&
          cached.config.value === config.value &&
          cached.config.version === config.version
        )
          return cached.catalog;
        const catalog = catalogOf(store.value, config.value);
        catalogs.set(agentDir, { store, config, catalog });
        return catalog;
      })
      .finally(() => running.delete(agentDir));
    running.set(agentDir, pending);
    return pending;
  };

  return async (sessionPath, provider, model) => {
    if (provider === null || model === null) return null;
    const agentDir = await sessionAgentDirOf(sessionPath);
    if (agentDir === null) return null;
    const catalog = await catalogFor(agentDir);
    const stored = catalog.contextWindow(provider, model);
    if (stored !== undefined) return stored;
    let cached = fallback.get(agentDir);
    if (cached?.catalog !== catalog) {
      const pending = loadPiModels(agentDir);
      cached = { catalog, pending };
      fallback.set(agentDir, cached);
      void pending.catch(() => {
        if (fallback.get(agentDir)?.pending === pending) fallback.delete(agentDir);
      });
    }
    const models = await cached.pending.catch(() => []);
    return models.find((item) => item.provider === provider && item.id === model)?.window ?? null;
  };
}

// セッションは <agent-dir>/sessions/<slug>/<file>.jsonl に置かれる。BFF の
// $PI_CODING_AGENT_DIR は pi を custom dir で起動したセッションと一致しないため、path から導く。
async function sessionAgentDirOf(sessionPath: string): Promise<string | null> {
  if (basename(dirname(dirname(sessionPath))) !== "sessions") return null;
  const candidate = dirname(dirname(dirname(sessionPath)));
  try {
    const info = await stat(candidate);
    return info.isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

// models-store.json が取得済みカタログの土台で、models.json の modelOverrides が最後に
// 重なる（pi の getAllModels と同じ順序）。store に無いモデルは override を書いても引けない。
function catalogOf(store: unknown, config: unknown): ModelCatalog {
  const windows = new Map<string, number | null>();
  const providers = asRecord(store);
  const overrides = asRecord(asRecord(config)?.providers);

  for (const [provider, value] of Object.entries(providers ?? {})) {
    const models = asRecord(value)?.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const record = asRecord(model);
      const id = nonEmptyText(record?.id);
      if (!id) continue;
      const override = asRecord(asRecord(overrides?.[provider])?.modelOverrides)?.[id];
      const overrideRecord = asRecord(override);
      const chosen =
        overrideRecord !== null && "contextWindow" in overrideRecord
          ? overrideRecord.contextWindow
          : record?.contextWindow;
      windows.set(catalogKey(provider, id), contextWindowValue(chosen));
    }
  }

  return {
    contextWindow(provider, model) {
      return windows.get(catalogKey(provider, model));
    },
  };
}

function catalogKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

// 0 以下や数値でない window は割合を壊す（Infinity）。pi の getContextUsage と同じく扱わない。
function contextWindowValue(value: unknown): number | null {
  const window = finiteNumber(value);
  return window !== null && window > 0 ? window : null;
}
