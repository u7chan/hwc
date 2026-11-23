import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentSkills } from "../shared/agent-skills";
import type { ModelAgentKind } from "../shared/agents";

// 一覧の上限。超えたら切ったことを返し、黙って一部だけ見せない。
const MAX_SKILLS = 200;

// あるディレクトリの下で見つけたスキル。realPath は同じ実体を 2 回数えないために持つ
// （~/.claude/skills は ~/.agents/skills への symlink なので、CLI によっては両方から見える）。
type Candidate = {
  // 表示名。frontmatter の name が無ければ id を使う。
  name: string;
  // OpenCode がスキルを選ぶ単位。パス由来なので、表示名が同じでも別のスキルになりうる。
  id: string;
  source: string;
  realPath: string;
  disabled: boolean;
};

// CLI が見るホーム配下の根。CLI 自身の環境変数が設定されていれば、その CLI と同じ場所を見る。
type Roots = { home: string; piAgent: string; claude: string; codex: string };

export function skillRoots(
  home: string,
  env: Record<string, string | undefined> = process.env,
): Roots {
  return {
    home,
    piAgent: env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent"),
    claude: env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    codex: env.CODEX_HOME ?? join(home, ".codex"),
  };
}

type WalkOptions = {
  // ルートから辿るディレクトリの深さ。CLI ごとの探索規則に合わせる。
  maxDepth: number;
  // ルート直下の `.md` もスキルとして扱うか（OpenCode だけがこの形を受ける）。
  rootMarkdown: boolean;
  // description の無いスキルを載せないか。Pi と Codex は description を必須にし、
  // Claude と OpenCode は名前だけで読み込む。
  requireDescription: boolean;
};

// SKILL.md の frontmatter から name と description の有無だけを読む。YAML 全体は要らない。
export function parseSkillFrontmatter(text: string): { name: string | null; described: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { name: null, described: false };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { name: null, described: false };
  let name: string | null = null;
  let described = false;
  for (const line of normalized.slice(3, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (match === null) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (match[1] === "name" && value !== "") name = value;
    if (match[1] === "description" && value !== "") described = true;
  }
  return { name, described };
}

async function skillAt(
  path: string,
  source: string,
  requireDescription: boolean,
): Promise<Candidate | null> {
  const file = join(path, "SKILL.md");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const front = parseSkillFrontmatter(text);
  if (requireDescription && !front.described) return null;
  return {
    name: front.name ?? basename(path),
    id: basename(path),
    source,
    realPath: await realpath(file).catch(() => file),
    disabled: false,
  };
}

async function markdownSkillAt(
  path: string,
  source: string,
  requireDescription: boolean,
): Promise<Candidate | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  const front = parseSkillFrontmatter(text);
  if (requireDescription && !front.described) return null;
  const id = basename(path, ".md");
  return {
    name: front.name ?? id,
    id,
    source,
    realPath: await realpath(path).catch(() => path),
    disabled: false,
  };
}

// 1 つのルートを辿る。SKILL.md を持つディレクトリは 1 スキルとして扱い、その中へは降りない
// （OpenCode の「SKILL.md を持つディレクトリは 1 スキル」に合わせる）。symlink は辿るが、
// 同じ実体を 2 度歩かないよう realpath で止める。
async function walk(
  root: string,
  options: WalkOptions,
  source: string,
  out: Candidate[],
): Promise<void> {
  const visited = new Set<string>();

  const visit = async (dir: string, depth: number): Promise<void> => {
    const real = await realpath(dir).catch(() => dir);
    if (visited.has(real)) return;
    visited.add(real);

    const own = await skillAt(dir, source, options.requireDescription);
    if (own !== null) {
      out.push(own);
      return;
    }

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // 隠しディレクトリと node_modules は CLI も読まない。
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      const info = await stat(full).catch(() => null);
      if (info === null) continue;
      if (info.isDirectory()) {
        if (depth < options.maxDepth) await visit(full, depth + 1);
        continue;
      }
      if (options.rootMarkdown && depth === 0 && entry.name.endsWith(".md")) {
        const skill = await markdownSkillAt(full, source, options.requireDescription);
        if (skill !== null) out.push(skill);
      }
    }
  };

  await visit(root, 0);
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Pi の packages は `npm:<name>` か `git:<host>/<path>@<ref>`。インストール先は
// <agent dir> 配下の 2 つの置き場に分かれる。
async function piPackages(agentDir: string): Promise<{ dir: string; source: string }[]> {
  const settings = asRecord(await readJson(join(agentDir, "settings.json")));
  const packages = settings?.packages;
  if (!Array.isArray(packages)) return [];
  const found: { dir: string; source: string }[] = [];
  for (const entry of packages) {
    if (typeof entry !== "string") continue;
    if (entry.startsWith("npm:")) {
      found.push({ dir: join(agentDir, "npm/node_modules", entry.slice(4)), source: entry });
      continue;
    }
    if (entry.startsWith("git:")) {
      // ref を落とす。`@` は末尾のものだけを見る（パスに `@` が入る場合に備える）。
      const spec = entry.slice(4);
      const at = spec.lastIndexOf("@");
      const path = at > spec.lastIndexOf("/") ? spec.slice(0, at) : spec;
      found.push({ dir: join(agentDir, "git", path), source: entry });
    }
  }
  return found;
}

// パッケージが manifest で宣言する置き場。`skills/` の規約に乗らないスキルはここに並ぶ。
async function piManifestSkills(dir: string): Promise<string[]> {
  const manifest = asRecord(await readJson(join(dir, "package.json")));
  const pi = asRecord(manifest?.pi);
  const skills = pi?.skills;
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => join(dir, entry));
}

async function piSkills(roots: Roots): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const options = { maxDepth: 4, rootMarkdown: false, requireDescription: true };
  await walk(join(roots.piAgent, "skills"), options, "~/.pi/agent/skills", out);
  await walk(join(roots.home, ".agents/skills"), options, "~/.agents/skills", out);
  for (const pkg of await piPackages(roots.piAgent)) {
    await walk(join(pkg.dir, "skills"), options, pkg.source, out);
    await walk(join(pkg.dir, ".agents/skills"), options, pkg.source, out);
    for (const dir of await piManifestSkills(pkg.dir)) {
      await walk(dir, options, pkg.source, out);
    }
  }
  return out;
}

// Claude の skillOverrides は "on" / "name-only" / "user-invocable-only" / "off"。
// off だけがモデルと `/` の両方から外す。user-invocable-only は `/` に残るので、
// 一覧では「読み込まれている」として扱う。
async function claudeOverrides(claudeDir: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const name of ["settings.json", "settings.local.json"]) {
    const settings = asRecord(await readJson(join(claudeDir, name)));
    const overrides = asRecord(settings?.skillOverrides);
    if (overrides === null) continue;
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === "string") merged[key] = value;
    }
  }
  return merged;
}

async function childDirs(dir: string, only?: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    // 隠しディレクトリと node_modules は CLI も読まない。
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    const info = await stat(full).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    if (only !== undefined && (await stat(join(full, only)).catch(() => null)) === null) continue;
    found.push(full);
  }
  return found;
}

async function claudeSkills(roots: Roots): Promise<Candidate[]> {
  const root = join(roots.claude, "skills");
  const overrides = await claudeOverrides(roots.claude);
  // バンドル（manifest.json を持つ同期済みスキル群）の名前空間は設定側のキーから読み取る。
  // 実体の manifest.json には名前空間が無いため、これが唯一の手掛かりになる。
  const prefixes = new Set(
    Object.keys(overrides)
      .filter((key) => key.includes(":"))
      .map((key) => key.slice(0, key.indexOf(":"))),
  );
  const namespace = prefixes.size === 1 ? [...prefixes][0] : null;

  const out: Candidate[] = [];
  const push = async (dir: string, prefix: string, source: string): Promise<void> => {
    // description は Claude では必須ではない。
    const skill = await skillAt(dir, source, false);
    if (skill === null) return;
    skill.disabled = overrides[`${prefix}${skill.name}`] === "off";
    out.push(skill);
  };

  for (const dir of await childDirs(root, "SKILL.md")) await push(dir, "", "~/.claude/skills");

  // バンドルは直下と、グループ 1 階層下の両方にある（同期されたスキルは `synced/<id>/`）。
  const bundles = [
    ...(await childDirs(root, "manifest.json")),
    ...(
      await Promise.all((await childDirs(root)).map((dir) => childDirs(dir, "manifest.json")))
    ).flat(),
  ];
  for (const bundle of bundles) {
    const prefix = `${namespace ?? basename(bundle)}:`;
    const source = `~/.claude/skills/${basename(join(bundle, ".."))}`;
    for (const dir of await childDirs(bundle, "SKILL.md")) await push(dir, prefix, source);
  }
  return out;
}

// Codex の `[[skills.config]]` は path / name のどちらかで 1 スキルを指し、enabled で
// 有効・無効を決める。同じスキルに複数が当たったときは後勝ち（公式の規則）。
export function parseCodexSkillRules(
  toml: string,
): { path: string | null; name: string | null; enabled: boolean }[] {
  return toml
    .split(/\[\[skills\.config\]\]/)
    .slice(1)
    .map((block) => {
      const path = /^\s*path\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? null;
      const name = /^\s*name\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? null;
      const enabled = /^\s*enabled\s*=\s*(true|false)/m.exec(block)?.[1] !== "false";
      return { path, name, enabled };
    });
}

async function codexSkills(roots: Roots): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const options = { maxDepth: 4, rootMarkdown: false, requireDescription: true };
  await walk(join(roots.home, ".agents/skills"), options, "~/.agents/skills", out);
  // 管理者用の置き場。無い環境や読めない環境では何も出ない。
  await walk("/etc/codex/skills", options, "/etc/codex/skills", out);

  const config = await readFile(join(roots.codex, "config.toml"), "utf8").catch(() => null);
  if (config === null) return out;
  for (const rule of parseCodexSkillRules(config)) {
    // 設定の path は実体へ解決してから比べる。symlink 側のパスで書かれていても効かせる。
    const resolved = rule.path === null ? null : await realpath(rule.path).catch(() => rule.path);
    for (const skill of out) {
      const matchesPath = resolved !== null && resolved === skill.realPath;
      const matchesName = rule.name !== null && rule.name === skill.name;
      if (matchesPath || matchesName) skill.disabled = !rule.enabled;
    }
  }
  return out;
}

async function opencodeSkills(roots: Roots): Promise<Candidate[]> {
  const out: Candidate[] = [];
  // 公式の探索先はグローバルと互換の 3 つ。深さは 6 まで。
  const options = { maxDepth: 6, rootMarkdown: true, requireDescription: false };
  const dirs = [
    [join(roots.home, ".config/opencode/skills"), "~/.config/opencode/skills"],
    [join(roots.claude, "skills"), "~/.claude/skills"],
    [join(roots.home, ".agents/skills"), "~/.agents/skills"],
  ] as const;
  for (const [dir, source] of dirs) await walk(dir, options, source, out);
  // opencode.json の `skills` はローカルパスだけを対象にする。相対パス（cwd 基準）と
  // HTTP カタログは設定画面に cwd が無いので読まない（docs/adr/agent-skills.md）。
  const config = asRecord(await readJson(join(roots.home, ".config/opencode/opencode.json")));
  const extra = config?.skills;
  if (Array.isArray(extra)) {
    for (const entry of extra) {
      if (typeof entry !== "string") continue;
      if (entry.startsWith("~/")) await walk(join(roots.home, entry.slice(2)), options, entry, out);
      else if (entry.startsWith("/")) await walk(entry, options, entry, out);
    }
  }
  return out;
}

const READERS: Record<ModelAgentKind, (roots: Roots) => Promise<Candidate[]>> = {
  pi: piSkills,
  claude: claudeSkills,
  codex: codexSkills,
  opencode: opencodeSkills,
};

function byRealPath(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((skill) => {
    if (seen.has(skill.realPath)) return false;
    seen.add(skill.realPath);
    return true;
  });
}

// 同じキーは先に見つかった方だけを残す。探索は CLI の優先順で並べてある。
function firstBy(candidates: Candidate[], key: (skill: Candidate) => string): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((skill) => {
    const value = key(skill);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export async function loadAgentSkills(
  agent: ModelAgentKind,
  home: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AgentSkills> {
  const found = await READERS[agent](skillRoots(home, env));
  // 同名・同 ID の扱いは CLI ごとに違う（docs/adr/agent-skills.md）。
  const unique =
    agent === "opencode"
      ? // OpenCode はパス由来の ID で選び、優先順位の高い置き場が勝つ。
        firstBy(found, (skill) => skill.id)
      : agent === "pi"
        ? // Pi は先に見つかった方を残し、後のコリジョンは捨てる。
          firstBy(found, (skill) => skill.name)
        : byRealPath(found);
  unique.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  const kept = unique.slice(0, MAX_SKILLS);
  return {
    truncated: unique.length > kept.length,
    skills: kept.map((skill) => ({
      name: skill.name,
      source: skill.source,
      state: skill.disabled ? "off" : "on",
    })),
  };
}
