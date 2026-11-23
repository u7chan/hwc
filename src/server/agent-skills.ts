import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentSkills } from "../shared/agent-skills";
import type { ModelAgentKind } from "../shared/agents";

// 一覧の上限。超えたら切ったことを返し、黙って一部だけ見せない。
const MAX_SKILLS = 200;

// あるディレクトリの下で見つけたスキル。realPath は同じ実体を 2 回数えないために持つ
// （~/.claude/skills は ~/.agents/skills への symlink なので、CLI によっては両方から見える）。
type Candidate = {
  name: string;
  source: string;
  realPath: string;
  disabled: boolean;
};

type WalkOptions = {
  // ルートから辿るディレクトリの深さ。CLI ごとの探索規則に合わせる。
  maxDepth: number;
  // ルート直下の `.md` もスキルとして扱うか（OpenCode だけがこの形を受ける）。
  rootMarkdown: boolean;
};

// SKILL.md の frontmatter から name と description の有無だけを読む。YAML 全体は要らない。
// description が無いスキルは Pi / Codex が読み込まないので、こちらも一覧に載せない。
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

async function skillAt(path: string, source: string): Promise<Candidate | null> {
  const text = await readFile(join(path, "SKILL.md"), "utf8").catch(() => null);
  if (text === null) return null;
  const front = parseSkillFrontmatter(text);
  if (!front.described) return null;
  return {
    name: front.name ?? basename(path),
    source,
    realPath: await realpath(join(path, "SKILL.md")).catch(() => join(path, "SKILL.md")),
    disabled: false,
  };
}

async function markdownSkillAt(path: string, source: string): Promise<Candidate | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  const front = parseSkillFrontmatter(text);
  if (!front.described) return null;
  const name = front.name ?? basename(path, ".md");
  return { name, source, realPath: await realpath(path).catch(() => path), disabled: false };
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

    const own = await skillAt(dir, source);
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
        const skill = await markdownSkillAt(full, source);
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
// ~/.pi/agent 配下の 2 つの置き場に分かれる。
async function piPackages(home: string): Promise<{ dir: string; source: string }[]> {
  const settings = asRecord(await readJson(join(home, ".pi/agent/settings.json")));
  const packages = settings?.packages;
  if (!Array.isArray(packages)) return [];
  const found: { dir: string; source: string }[] = [];
  for (const entry of packages) {
    if (typeof entry !== "string") continue;
    if (entry.startsWith("npm:")) {
      found.push({ dir: join(home, ".pi/agent/npm/node_modules", entry.slice(4)), source: entry });
      continue;
    }
    if (entry.startsWith("git:")) {
      // ref を落とす。`@` は末尾のものだけを見る（パスに `@` が入る場合に備える）。
      const spec = entry.slice(4);
      const at = spec.lastIndexOf("@");
      const path = at > spec.lastIndexOf("/") ? spec.slice(0, at) : spec;
      found.push({ dir: join(home, ".pi/agent/git", path), source: entry });
    }
  }
  return found;
}

async function piSkills(home: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const options = { maxDepth: 4, rootMarkdown: false };
  await walk(join(home, ".pi/agent/skills"), options, "~/.pi/agent/skills", out);
  await walk(join(home, ".agents/skills"), options, "~/.agents/skills", out);
  for (const pkg of await piPackages(home)) {
    await walk(join(pkg.dir, "skills"), options, pkg.source, out);
    await walk(join(pkg.dir, ".agents/skills"), options, pkg.source, out);
  }
  return out;
}

// Claude の skillOverrides は "on" / "name-only" / "user-invocable-only" / "off"。
// モデルから見えなくなるのは "off" だけなので、それ以外は認識している扱いにする。
async function claudeOverrides(home: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const name of ["settings.json", "settings.local.json"]) {
    const settings = asRecord(await readJson(join(home, ".claude", name)));
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

async function claudeSkills(home: string): Promise<Candidate[]> {
  const root = join(home, ".claude/skills");
  const overrides = await claudeOverrides(home);
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
    const skill = await skillAt(dir, source);
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

async function codexSkills(home: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const options = { maxDepth: 4, rootMarkdown: false };
  await walk(join(home, ".agents/skills"), options, "~/.agents/skills", out);
  // 管理者用の置き場。無い環境や読めない環境では何も出ない。
  await walk("/etc/codex/skills", options, "/etc/codex/skills", out);

  const config = await readFile(join(home, ".codex/config.toml"), "utf8").catch(() => null);
  if (config === null) return out;
  for (const rule of parseCodexSkillRules(config)) {
    for (const skill of out) {
      const matchesPath = rule.path !== null && rule.path === skill.realPath;
      const matchesName = rule.name !== null && rule.name === skill.name;
      if (matchesPath || matchesName) skill.disabled = !rule.enabled;
    }
  }
  return out;
}

async function opencodeSkills(home: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  // 公式の探索先はグローバルと互換の 3 つ。深さは 6 まで。
  const options = { maxDepth: 6, rootMarkdown: true };
  for (const dir of [".config/opencode/skills", ".claude/skills", ".agents/skills"]) {
    await walk(join(home, dir), options, `~/${dir}`, out);
  }
  // opencode.json の `skills` はローカルパスだけを対象にする。相対パス（cwd 基準）と
  // HTTP カタログは設定画面に cwd が無いので読まない。
  const config = asRecord(await readJson(join(home, ".config/opencode/opencode.json")));
  const extra = config?.skills;
  if (Array.isArray(extra)) {
    for (const entry of extra) {
      if (typeof entry !== "string") continue;
      if (entry.startsWith("~/")) await walk(join(home, entry.slice(2)), options, entry, out);
      else if (entry.startsWith("/")) await walk(entry, options, entry, out);
    }
  }
  return out;
}

const READERS: Record<ModelAgentKind, (home: string) => Promise<Candidate[]>> = {
  pi: piSkills,
  claude: claudeSkills,
  codex: codexSkills,
  opencode: opencodeSkills,
};

export async function loadAgentSkills(agent: ModelAgentKind, home: string): Promise<AgentSkills> {
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const skill of await READERS[agent](home)) {
    if (seen.has(skill.realPath)) continue;
    seen.add(skill.realPath);
    unique.push(skill);
  }
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
