import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStoredTemplates, type Template } from "../shared/templates";

export type TemplatesFile = {
  read: () => string | null;
  write: (raw: string) => void;
};

export function templatesPath(root: string): string {
  return join(root, "templates.json");
}

// 添付・通知設定と同じ状態ディレクトリ配下の 1 ファイル。固定の tmp 名は並行した
// 書き込みや前回の残骸と衝突するので、一意な名前で作って rename で置き換える。
export function createTemplatesFile(root: string): TemplatesFile {
  const path = templatesPath(root);
  let serial = 0;
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // まだ無い・読めないは空で始める。定型文が無いだけで起動は止めない。
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

// 書き込みが成功したときだけメモリを置き換える。失敗すれば古い一覧が残る。
export type TemplatesStore = {
  get: () => Template[];
  save: (next: Template[]) => void;
};

export function createTemplatesStore(file: TemplatesFile): TemplatesStore {
  let current = parseJson(file.read());
  return {
    get: () => current,
    save: (next) => {
      file.write(JSON.stringify(next));
      current = next;
    },
  };
}

function parseJson(raw: string | null): Template[] {
  if (raw === null) return [];
  try {
    return parseStoredTemplates(JSON.parse(raw));
  } catch {
    // 壊れた JSON は空へ落とす。中身を直す入口は設定画面の上書きだけ。
    return [];
  }
}
