import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type StateFile = {
  read: () => string | null;
  write: (raw: string) => void;
};

// 状態ディレクトリ配下の 1 ファイルを丸ごと置き換える（docs/adr/state-storage.md）。固定の
// tmp 名は並行した書き込みや前回の残骸と衝突するので、プロセス内の連番を足した一意な名前で
// 作ってから rename で置き換える。資格情報を含むファイルは mode 0o600 を渡す。
export function createStateFile(path: string, options: { mode?: number } = {}): StateFile {
  const { mode } = options;
  let serial = 0;
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // まだ無い・読めないは各設定の既定で始める。設定を読めないだけで起動は止めない。
        return null;
      }
    },
    write: (raw) => {
      mkdirSync(dirname(path), { recursive: true });
      serial += 1;
      const tmp = `${path}.${process.pid}.${serial}.tmp`;
      try {
        writeFileSync(tmp, raw, mode === undefined ? { flag: "wx" } : { mode, flag: "wx" });
        // 既存ファイルの umask に影響されないよう、書き込み後にも明示する。
        if (mode !== undefined) chmodSync(tmp, mode);
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

export type JsonStore<T> = {
  get: () => T;
  save: (next: T) => void;
};

// 壊れた JSON は既定値へ落とす。中身を直す入口は設定画面の上書きだけ。書き込みが成功した
// ときだけメモリを置き換えるので、失敗すれば古い値が残る。
export function createJsonStore<T>(
  file: StateFile,
  fallback: T,
  parse: (value: unknown) => T,
): JsonStore<T> {
  let current = parseStoredJson(file.read(), fallback, parse);
  return {
    get: () => current,
    save: (next) => {
      file.write(JSON.stringify(next));
      current = next;
    },
  };
}

function parseStoredJson<T>(raw: string | null, fallback: T, parse: (value: unknown) => T): T {
  if (raw === null) return fallback;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}
