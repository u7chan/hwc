import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelAgentKind } from "../shared/agents";
import {
  type LaunchDefault,
  type LaunchDefaults,
  parseLaunchDefaults,
} from "../shared/launch-defaults";

export type LaunchDefaultsFile = {
  read: () => string | null;
  write: (raw: string) => void;
};

export function launchDefaultsPath(root: string): string {
  return join(root, "launch-defaults.json");
}

// 定型文と同じ状態ディレクトリ配下の 1 ファイル。固定の tmp 名は並行した書き込みや前回の
// 残骸と衝突するので、一意な名前で作って rename で置き換える。
export function createLaunchDefaultsFile(root: string): LaunchDefaultsFile {
  const path = launchDefaultsPath(root);
  let serial = 0;
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // まだ無い・読めないは未設定で始める。既定が無ければ、ダイアログで毎回選ぶだけ。
        return null;
      }
    },
    write: (raw) => {
      mkdirSync(root, { recursive: true });
      serial += 1;
      const tmp = `${path}.${process.pid}.${serial}.tmp`;
      try {
        writeFileSync(tmp, raw, { flag: "wx" });
        renameSync(tmp, path);
      } catch (error) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // 後片付けの失敗で元のエラーを隠さない。
        }
        throw error;
      }
    },
  };
}

// 書き込みが成功したときだけメモリを置き換える。失敗すれば古い既定が残る。
export type LaunchDefaultsStore = {
  get: () => LaunchDefaults;
  set: (agent: ModelAgentKind, value: LaunchDefault | null) => void;
};

export function createLaunchDefaultsStore(file: LaunchDefaultsFile): LaunchDefaultsStore {
  let current = parseJson(file.read());
  return {
    get: () => current,
    set: (agent, value) => {
      const next = { ...current };
      if (value === null) delete next[agent];
      else next[agent] = value;
      file.write(JSON.stringify(next));
      current = next;
    },
  };
}

function parseJson(raw: string | null): LaunchDefaults {
  if (raw === null) return {};
  try {
    return parseLaunchDefaults(JSON.parse(raw));
  } catch {
    // 壊れた JSON は未設定へ落とす。直す入口は設定画面での保存・解除だけ。
    return {};
  }
}
