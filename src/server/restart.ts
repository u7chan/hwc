import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { parseRestartSettings, type RestartSettings } from "../shared/restart";
import { createJsonStore, createStateFile, type JsonStore, type StateFile } from "./state-file";

export type RestartSettingsFile = StateFile;

export function restartSettingsPath(root: string): string {
  return join(root, "restart.json");
}

// 添付・ペイン時刻と同じ状態ディレクトリ配下の 1 ファイル（docs/adr/state-storage.md）。書式は通知設定に揃える。
export function createRestartSettingsFile(root: string): RestartSettingsFile {
  return createStateFile(restartSettingsPath(root));
}

export type RestartSettingsStore = JsonStore<RestartSettings>;

export function createRestartSettingsStore(file: RestartSettingsFile): RestartSettingsStore {
  return createJsonStore(file, parseRestartSettings(null), parseRestartSettings);
}

export type RestartOutcome = "started" | "not_executable";

export type RestartRunner = {
  // 応答を返す前に確かめるための判定。実行はしない。
  isExecutable: (command: string) => boolean;
  // 実行ファイルを直接起動する。終了は待たない（HWC 自身を止めるコマンドが入り得る）。
  // cwd は pull したチェックアウト。どのリポジトリを再起動してよいかはコマンドが cwd で判定する。
  run: (command: string, cwd: string) => RestartOutcome;
};

type Spawn = (command: string, cwd: string) => { exited: Promise<number> };

// 起動できなかったことと、0 以外で終わったことをログに残す。設定したコマンドが動かない
// まま気づけないと、設定画面には成功に見える。
export function createRestartRunner(options: { spawn?: Spawn } = {}): RestartRunner {
  const spawn = options.spawn ?? spawnDetached;
  const isExecutable = (command: string): boolean => {
    try {
      if (!statSync(command).isFile()) return false;
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  return {
    isExecutable,
    run: (command, cwd) => {
      if (!isExecutable(command)) return "not_executable";
      const child = spawn(command, cwd);
      child.exited.then(
        (code) => {
          if (code !== 0) console.error(`restart: ${command} exited with ${code}`);
        },
        (error: unknown) => console.error(`restart: ${command}: ${String(error)}`),
      );
      return "started";
    },
  };
}

function spawnDetached(command: string, cwd: string) {
  return Bun.spawn([command], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}
