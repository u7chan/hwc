// プロジェクトの候補は BFF が返し、クライアントは選んだパスを本文へ入れるだけ。
// 表示に使うのはディレクトリ名と、ペインの cwd からの相対パス。
export type ProjectEntry = {
  name: string;
  path: string;
};

export type ProjectList = {
  projects: ProjectEntry[];
  truncated: boolean;
};

// 一覧を丸ごとクライアントへ送る上限。これを超えたら truncated を立てる。
export const MAX_PROJECTS = 300;

export function isProjectEntry(value: unknown): value is ProjectEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ProjectEntry>;
  if (typeof entry.name !== "string" || entry.name === "") return false;
  if (typeof entry.path !== "string" || entry.path === "" || entry.path === ".") return false;
  if (entry.path.startsWith("/") || entry.path.startsWith("./")) return false;
  return !entry.path.split("/").includes("..");
}

// 応答の形が崩れていたら、一覧を出さずに失敗として扱う。部分的に正しい行だけを
// 混ぜると、選んだパスが意図しない場所を指し得る。
export function parseProjectList(value: unknown): ProjectList | null {
  if (typeof value !== "object" || value === null) return null;
  const list = value as Partial<ProjectList>;
  if (!Array.isArray(list.projects) || typeof list.truncated !== "boolean") return null;
  if (!list.projects.every(isProjectEntry)) return null;
  return { projects: list.projects, truncated: list.truncated };
}
