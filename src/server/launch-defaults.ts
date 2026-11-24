import { join } from "node:path";
import type { ModelAgentKind } from "../shared/agents";
import {
  type LaunchDefault,
  type LaunchDefaults,
  parseLaunchDefaults,
} from "../shared/launch-defaults";
import { createJsonStore, createStateFile, type JsonStore, type StateFile } from "./state-file";

export type LaunchDefaultsFile = StateFile;

export function launchDefaultsPath(root: string): string {
  return join(root, "launch-defaults.json");
}

// 定型文と同じ状態ディレクトリ配下の 1 ファイル。
export function createLaunchDefaultsFile(root: string): LaunchDefaultsFile {
  return createStateFile(launchDefaultsPath(root));
}

export type LaunchDefaultsStore = {
  get: () => LaunchDefaults;
  set: (agent: ModelAgentKind, value: LaunchDefault | null) => void;
};

export function createLaunchDefaultsStore(file: LaunchDefaultsFile): LaunchDefaultsStore {
  // 壊れた JSON は未設定へ落とす。直す入口は設定画面での保存・解除だけ。
  const store: JsonStore<LaunchDefaults> = createJsonStore(file, {}, parseLaunchDefaults);
  return {
    get: () => store.get(),
    set: (agent, value) => {
      const next = { ...store.get() };
      if (value === null) delete next[agent];
      else next[agent] = value;
      store.save(next);
    },
  };
}
