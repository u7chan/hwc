import type { ProjectEntry } from "../shared/projects";
import { insertAtSelection, type Insertion } from "./input";

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

export type ProjectInsertion = Insertion;

// 選択範囲を置き換え、前後の語とくっつかないよう必要なら空白を足す。
export function insertProjectPath(
  draft: string,
  start: number,
  end: number,
  path: string,
): ProjectInsertion {
  return insertAtSelection(draft, start, end, projectInsertion(path));
}

export type ProjectMention = {
  // `@` の位置と、置き換える範囲の終わり（キャレット）。
  start: number;
  end: number;
  query: string;
};

// キャレット直前の `@語` を拾う。`@` は行頭か空白の直後に限る。`a@example.com` や、
// 語の途中の `@` を補完の入力と取り違えると、メールアドレスや `@types/node` を打てなくなる。
export function projectMention(draft: string, caret: number): ProjectMention | null {
  const end = Math.min(caret, draft.length);
  let start = end;
  while (start > 0 && !/\s/.test(draft.charAt(start - 1))) start -= 1;
  if (draft.charAt(start) !== "@" || start === end) return null;
  return { start, end, query: draft.slice(start + 1, end) };
}

// 強調中の候補は path だけを持つ。絞り込みで消えたら先頭に戻るので、リセットの処理は要らない。
export function highlightedProject(
  candidates: readonly ProjectEntry[],
  highlighted: string | null,
): ProjectEntry | null {
  return candidates.find((project) => project.path === highlighted) ?? candidates[0] ?? null;
}

// 端で折り返して、↑↓ を押し続けても止まらないようにする。
export function stepProject(
  candidates: readonly ProjectEntry[],
  highlighted: string | null,
  step: 1 | -1,
): string | null {
  const current = highlightedProject(candidates, highlighted);
  if (current === null) return null;
  const index = candidates.indexOf(current);
  return candidates[(index + step + candidates.length) % candidates.length]?.path ?? null;
}
