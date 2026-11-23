// ファイルツリーの行に出す印の種類。名前の拡張子だけで決める（中身は読まない）。
// 細かく分けるほど 16px では見分けられず、拡張子が増えるたびに手入れも要るので、
// 当てはまらないものは書類 1 枚に寄せる。
export type FileKind = "code" | "data" | "style" | "file" | "image" | "shell" | "lock";

// ロックファイルは拡張子が .json / .yaml でも、名前で見分ける。上から順に効くので、
// ほかの表より先に判定する。
const LOCK_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "flake.lock",
  "gemfile.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

const EXTENSIONS: Record<Exclude<FileKind, "file" | "lock">, readonly string[]> = {
  code: "ts tsx mts cts js jsx mjs cjs py go rs rb php java kt kts swift cs lua pl html htm vue svelte astro".split(
    " ",
  ),
  data: "json jsonc yaml yml toml ini csv env".split(" "),
  style: "css scss less sass".split(" "),
  image: "png jpg jpeg gif webp avif ico bmp svg".split(" "),
  shell: "sh bash zsh fish ps1".split(" "),
};

const BY_EXTENSION = new Map<string, FileKind>(
  (Object.keys(EXTENSIONS) as (keyof typeof EXTENSIONS)[]).flatMap((kind) =>
    EXTENSIONS[kind].map((extension) => [extension, kind] as const),
  ),
);

// `.env.local` のように拡張子が後ろに付くものと、そのもの自体を同じ扱いにする。
// 点で始まるだけの名前（.gitignore）は拡張子なしとして書類に落とす。
export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".lock") || LOCK_NAMES.has(lower)) return "lock";
  if (lower === ".env" || lower.startsWith(".env.")) return "data";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return "file";
  return BY_EXTENSION.get(lower.slice(dot + 1)) ?? "file";
}
