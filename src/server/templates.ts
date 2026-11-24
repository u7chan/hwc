import { join } from "node:path";
import { parseStoredTemplates, type Template } from "../shared/templates";
import { createJsonStore, createStateFile, type JsonStore, type StateFile } from "./state-file";

export type TemplatesFile = StateFile;

export function templatesPath(root: string): string {
  return join(root, "templates.json");
}

// 添付・通知設定と同じ状態ディレクトリ配下の 1 ファイル。
export function createTemplatesFile(root: string): TemplatesFile {
  return createStateFile(templatesPath(root));
}

export type TemplatesStore = JsonStore<Template[]>;

export function createTemplatesStore(file: TemplatesFile): TemplatesStore {
  // 壊れた JSON は空へ落とす。中身を直す入口は設定画面の上書きだけ。
  return createJsonStore(file, [], parseStoredTemplates);
}
