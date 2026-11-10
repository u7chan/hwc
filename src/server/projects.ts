import { isAbsolute, posix } from "node:path";
import { MAX_PROJECTS, type ProjectList } from "../shared/projects";

// パッケージ管理ファイルがあるディレクトリをプロジェクトとみなす。言語ごとの
// ワークスペース定義（pnpm-workspace.yaml など）は読まない。ファイルがあるかだけで
// 判定できるため、モノレポの規約に依存せず、言語が混在していても候補が出る。
const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "Gemfile",
  "composer.json",
  "Package.swift",
  "pubspec.yaml",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
]);

const MANIFEST_SUFFIXES = [".gemspec", ".csproj", ".fsproj", ".vbproj"] as const;

// git 管理下でも、生成物や依存の下にマニフェストが残っていることがある。
// .gitignore だけに頼らず、プロジェクトとして選ぶ意味のないディレクトリは落とす。
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "target",
  "vendor",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
]);

export function isManifestName(name: string): boolean {
  if (MANIFEST_NAMES.has(name)) return true;
  return MANIFEST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function ignored(path: string): boolean {
  return path.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));
}

function depth(path: string): number {
  return path.split("/").length;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// git ls-files -z の出力。壊れた入力を捨て、NUL で区切られたパスだけを返す。
export function splitGitPaths(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

// cwd 自身は候補にしない。エージェントは既にそこにいるので、選んで相対パスを
// 挿入する意味がなく、`.` を本文へ置くのも不自然になる。
export function projectEntries(files: Iterable<string>): ProjectList {
  const directories = new Set<string>();
  for (const file of files) {
    if (file.startsWith("/") || file === "") continue;
    const name = posix.basename(file);
    if (!isManifestName(name)) continue;
    const directory = posix.dirname(file);
    if (directory === "." || directory === "" || directory.startsWith("../")) continue;
    if (directory.split("/").includes("..") || ignored(directory)) continue;
    directories.add(directory);
  }

  const sorted = [...directories].sort((a, b) => depth(a) - depth(b) || comparePaths(a, b));
  return {
    projects: sorted.slice(0, MAX_PROJECTS).map((path) => ({
      name: posix.basename(path),
      path,
    })),
    truncated: sorted.length > MAX_PROJECTS,
  };
}

export type ProjectLister = {
  list: (options: { cwd: string }) => Promise<ProjectList>;
};

export type ProjectCommand = {
  stdout: string;
  stderr: string;
  code: number;
};

type ProjectRunner = (cwd: string) => Promise<ProjectCommand>;

export const PROJECTS_TTL_MS = 30_000;
const GIT_TIMEOUT_MS = 5_000;
// 非 git のディレクトリでもペインは作れる。このメッセージのときだけ空の一覧に畳み、
// 壊れた index や dubious ownership など、git はあるが読めない失敗は 502 に回す。
const NOT_A_REPOSITORY = /not a git repository/i;

export function projectCommandOutput(result: ProjectCommand): string {
  if (result.code === 0) return result.stdout;
  if (result.code === 128 && NOT_A_REPOSITORY.test(result.stderr)) return "";
  throw new Error("git ls-files failed");
}

// マニフェストの追加はコミット単位でしか起きないが、BFF にファイル監視は無い。
// 短い TTL で読み直し、ペインを切り替えても同じ cwd の結果を共有する。
export function createProjectLister(
  options: {
    run?: ProjectRunner;
    ttlMs?: number;
    now?: () => number;
  } = {},
): ProjectLister {
  const run = options.run ?? readProjectFiles;
  const ttlMs = options.ttlMs ?? PROJECTS_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: ProjectList }>();

  return {
    async list({ cwd }) {
      const at = now();
      const hit = cache.get(cwd);
      if (hit !== undefined && at - hit.at < ttlMs) return hit.value;

      const value = projectEntries(splitGitPaths(projectCommandOutput(await run(cwd))));
      cache.set(cwd, { at, value });
      return value;
    },
  };
}

async function readProjectFiles(cwd: string): Promise<ProjectCommand> {
  if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
  // 調査用プロセスが呼び出し元のペインを自分のものとして報告しないようにする。
  // env を明示しないと、Bun は起動時の PATH で実行ファイルを探し、E2E の偽 git を通らない。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  // git のエラー文言で非 git を見分けるため、ロケールを固定する。
  env.LC_ALL = "C";
  const child = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
