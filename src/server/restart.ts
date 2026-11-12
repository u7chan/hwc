import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseRestartSettings, type RestartSettings } from "../shared/restart";

export type RestartSettingsFile = {
  read: () => string | null;
  write: (raw: string) => void;
};

export function restartSettingsPath(root: string): string {
  return join(root, "restart.json");
}

// 添付・ペイン時刻と同じ状態ディレクトリ配下の 1 ファイル（ADR 0018）。書式は通知設定に
// 揃える。固定の tmp 名は並行した書き込みや前回の残骸と衝突するので、一意な名前で作って
// rename で置き換える。
export function createRestartSettingsFile(root: string): RestartSettingsFile {
  const path = restartSettingsPath(root);
  let serial = 0;
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // まだ無い・読めないは既定値で始める。設定を読めないだけで起動は止めない。
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

// 書き込みが成功したときだけメモリを置き換える。失敗すれば古い設定が残る。
export type RestartSettingsStore = {
  get: () => RestartSettings;
  save: (next: RestartSettings) => void;
};

export function createRestartSettingsStore(file: RestartSettingsFile): RestartSettingsStore {
  let current = parseJson(file.read());
  return {
    get: () => current,
    save: (next) => {
      file.write(JSON.stringify(next));
      current = next;
    },
  };
}

function parseJson(raw: string | null): RestartSettings {
  if (raw === null) return parseRestartSettings(null);
  try {
    return parseRestartSettings(JSON.parse(raw));
  } catch {
    // 壊れた JSON は既定値へ落とす。中身を直す入口は設定画面の上書きだけ。
    return parseRestartSettings(null);
  }
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
