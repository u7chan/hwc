import type { ChatLinkKind } from "./message-files";

// 1 ディレクトリで返す行の上限。巨大な node_modules を開いても応答と描画が止まらない
// ようにする。超えたことは total で伝え、画面に 1 行出す。
export const FILE_TREE_LIMIT = 200;

// ディレクトリ。expandable は根の外を指す symlink など、子を取得できないものだけ false。
export type FileTreeDir = {
  kind: "dir";
  name: string;
  path: string;
  expandable: boolean;
  // .gitignore など、git が無視する項目。開けるかどうかとは別で、行を淡色にする。
  ignored?: boolean;
};

// 開けないファイルも行としては出す（open が null）。ツリーの穴を空けないため。
export type FileTreeFile = {
  kind: "file";
  name: string;
  path: string;
  open: ChatLinkKind | null;
  version: string;
  ignored?: boolean;
};

export type FileTreeEntry = FileTreeDir | FileTreeFile;

export type FileTreeListing = {
  entries: FileTreeEntry[];
  // 上限で切る前の件数。
  total: number;
  truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 絶対パスと親参照はクライアントへ渡さない（docs/adr/file-serving.md）。名前は根からの相対パスだけ。
// `\` は POSIX のファイル名として合法なので、区切りとしてではなく名前の一部として通す。
function isRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function toEntry(value: unknown): FileTreeEntry | null {
  if (!isRecord(value)) return null;
  const name = value.name;
  const path = value.path;
  if (typeof name !== "string" || typeof path !== "string") return null;
  if (name === "" || name.includes("/") || !isRelativePath(path)) return null;
  if (path !== name && !path.endsWith(`/${name}`)) return null;
  const ignored = value.ignored === true ? { ignored: true } : {};

  if (value.kind === "dir") {
    return { kind: "dir", name, path, expandable: value.expandable === true, ...ignored };
  }
  if (value.kind !== "file") return null;

  const open = value.open;
  if (open !== null && open !== "image" && open !== "html" && open !== "text") return null;
  if (typeof value.version !== "string") return null;
  return { kind: "file", name, path, open, version: value.version, ...ignored };
}

export function parseFileTree(value: unknown): FileTreeListing | null {
  if (!isRecord(value)) return null;
  const entries = value.entries;
  const total = value.total;
  const truncated = value.truncated;
  if (!Array.isArray(entries)) return null;
  if (typeof total !== "number" || !Number.isInteger(total) || total < entries.length) return null;
  if (typeof truncated !== "boolean") return null;

  const parsed: FileTreeEntry[] = [];
  for (const item of entries) {
    const entry = toEntry(item);
    if (entry === null) return null;
    parsed.push(entry);
  }
  return { entries: parsed, total, truncated };
}
