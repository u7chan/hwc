import type { ProjectEntry } from "../shared/projects";

// 一覧を描画する上限。モノレポでも検索語で絞れるよう、全件を DOM に出さない。
export const VISIBLE_PROJECTS = 50;

function rank(project: ProjectEntry, query: string): number | null {
  const name = project.name.toLowerCase();
  const path = project.path.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.startsWith(query)) return 3;
  if (path.includes(query)) return 4;
  return null;
}

// 名前の一致をパスの一致より先に置く。`web` で `packages/web` が、`apps/web-tools` より
// 先に出るようにするため。同じ順位はサーバーが返した順（浅い順）を保つ。
export function filterProjects(
  projects: readonly ProjectEntry[],
  query: string,
  limit = VISIBLE_PROJECTS,
): ProjectEntry[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return projects.slice(0, limit);

  return projects
    .map((project) => ({ project, rank: rank(project, normalized) }))
    .filter((item): item is { project: ProjectEntry; rank: number } => item.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((item) => item.project);
}

// 本文へ入れるのは相対パスだけ。エージェントの cwd から解決させる。
export function projectInsertion(path: string): string {
  return `./${path}/`;
}

export type ProjectInsertion = {
  text: string;
  caret: number;
};

// 選択範囲を置き換え、前後の語とくっつかないよう必要なら空白を足す。
export function insertProjectPath(
  draft: string,
  start: number,
  end: number,
  path: string,
): ProjectInsertion {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^\s/.test(after) ? " " : "";
  const inserted = projectInsertion(path);
  return {
    text: `${before}${lead}${inserted}${trail}${after}`,
    caret: before.length + lead.length + inserted.length,
  };
}
