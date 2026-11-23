import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp } from "./app.test-helpers";
import {
  loadAgentSkills,
  parseCodexSkillRules,
  parseSkillFrontmatter,
  skillRoots,
} from "./agent-skills";

// CLI の環境変数がテスト実行元から漏れないよう、明示的に空の env を渡す。
const NO_ENV = {};

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "hwc-skills-"));
}

async function writeSkill(path: string, name: string, description = "説明"): Promise<void> {
  await mkdir(path, { recursive: true });
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n\n本文\n`;
  await writeFile(join(path, "SKILL.md"), frontmatter);
}

test("frontmatter から name と description を読む", () => {
  expect(parseSkillFrontmatter("---\nname: gh\ndescription: x\n---\n")).toEqual({
    name: "gh",
    description: "x",
  });
  // description が無いスキルは Pi / Codex が読み込まない。
  expect(parseSkillFrontmatter("---\nname: gh\n---\n")).toEqual({
    name: "gh",
    description: null,
  });
  expect(parseSkillFrontmatter("# 見出しだけ")).toEqual({ name: null, description: null });
});

test("description は 1 行・引用・折り返しのどの書き方でも 1 行にそろえて読む", () => {
  const read = (frontmatter: string) =>
    parseSkillFrontmatter(`---\n${frontmatter}\n---\n`).description;

  expect(read("description: コードを読む")).toBe("コードを読む");
  expect(read('description: "引用: コロンを含む \\"説明\\""')).toBe('引用: コロンを含む "説明"');
  expect(read("description: 'it''s fine'")).toBe("it's fine");
  // 折り返した plain と、`>` / `|` の本文。後ろのキーまでは巻き込まない。
  expect(read("description: 一行目\n  二行目\nname: gh")).toBe("一行目 二行目");
  expect(read("description: >-\n  first line\n  second line\nname: gh")).toBe(
    "first line second line",
  );
  expect(read("description: |\n  first\n\n  second\nname: gh")).toBe("first second");
});

test("入れ子のキーや中身の無い description は、description として読まない", () => {
  const read = (frontmatter: string) =>
    parseSkillFrontmatter(`---\n${frontmatter}\n---\n`).description;

  expect(read("name: gh\nmetadata:\n  description: 入れ子")).toBeNull();
  expect(read("description: >\nname: gh")).toBeNull();
  expect(read('description: ""')).toBeNull();
});

test("長い description は、文字の途中で切らずに末尾へ … を付ける", () => {
  const long = "あ".repeat(300);
  const description = parseSkillFrontmatter(`---\ndescription: ${long}\n---\n`).description;

  expect(description).toBe(`${"あ".repeat(240)}…`);
  // サロゲートペアの 𠮷 を 1 文字として数える。
  const pairs = "𠮷".repeat(241);
  expect(parseSkillFrontmatter(`---\ndescription: ${pairs}\n---\n`).description).toBe(
    `${"𠮷".repeat(240)}…`,
  );
});

test("設定ルートは CLI の環境変数を優先する", () => {
  const roots = skillRoots("/home/example", {
    PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    CLAUDE_CONFIG_DIR: "/tmp/claude",
    CODEX_HOME: "/tmp/codex",
  });
  expect(roots).toEqual({
    home: "/home/example",
    piAgent: "/tmp/pi-agent",
    claude: "/tmp/claude",
    codex: "/tmp/codex",
  });
  // 環境変数が無ければホーム配下。
  expect(skillRoots("/home/example", NO_ENV)).toEqual({
    home: "/home/example",
    piAgent: "/home/example/.pi/agent",
    claude: "/home/example/.claude",
    codex: "/home/example/.codex",
  });
});

test("Pi は 2 つのスキル置き場と packages のスキルをまとめる", async () => {
  const home = await tempHome();
  try {
    await writeSkill(join(home, ".agents/skills/gh"), "gh");
    await writeSkill(join(home, ".pi/agent/skills/local"), "local");
    await writeSkill(
      join(home, ".pi/agent/npm/node_modules/pi-codex-image-gen/skills/imagegen"),
      "imagegen",
    );
    await writeFile(
      join(home, ".pi/agent/settings.json"),
      JSON.stringify({ packages: ["npm:pi-codex-image-gen"] }),
    );
    // 説明の無い SKILL.md は一覧に載せない。
    await writeSkill(join(home, ".agents/skills/broken"), "broken", "");

    const view = await loadAgentSkills("pi", home, NO_ENV);

    expect(view.skills.map((skill) => [skill.name, skill.source, skill.state])).toEqual([
      ["gh", "~/.agents/skills", "on"],
      ["imagegen", "npm:pi-codex-image-gen", "on"],
      ["local", "~/.pi/agent/skills", "on"],
    ]);
    expect(view.truncated).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi はパッケージの manifest が宣言する置き場も読む", async () => {
  const home = await tempHome();
  try {
    const pkg = join(home, ".pi/agent/npm/node_modules/demo-pkg");
    await writeSkill(join(pkg, "resources/skills/release"), "release");
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ pi: { skills: ["./resources/skills"] } }),
    );
    await mkdir(join(home, ".pi/agent"), { recursive: true });
    await writeFile(
      join(home, ".pi/agent/settings.json"),
      JSON.stringify({ packages: ["npm:demo-pkg"] }),
    );

    const view = await loadAgentSkills("pi", home, NO_ENV);

    expect(view.skills).toEqual([
      { name: "release", source: "npm:demo-pkg", state: "on", description: "説明" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi は同名のスキルを先に見つかった置き場だけ残す", async () => {
  const home = await tempHome();
  try {
    // Pi のコリジョンは宣言した name で判定する。先に見つかった置き場だけが残る。
    await writeSkill(join(home, ".pi/agent/skills/gh"), "gh", "先に見つかる方");
    await writeSkill(join(home, ".agents/skills/gh"), "gh", "後に見つかる方");

    const view = await loadAgentSkills("pi", home, NO_ENV);

    expect(view.skills).toEqual([
      { name: "gh", source: "~/.pi/agent/skills", state: "on", description: "先に見つかる方" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi は PI_CODING_AGENT_DIR のスキルを読む", async () => {
  const home = await tempHome();
  try {
    await writeSkill(join(home, "agent/skills/local"), "local");

    const view = await loadAgentSkills("pi", home, {
      PI_CODING_AGENT_DIR: join(home, "agent"),
    });

    expect(view.skills).toEqual([
      { name: "local", source: "~/.pi/agent/skills", state: "on", description: "説明" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude は description の無いスキルも読み、バンドルは skillOverrides で無効にする", async () => {
  const home = await tempHome();
  try {
    // Claude は description を必須にしない。名前だけで読み込まれる。
    const named = join(home, ".claude/skills/named");
    await mkdir(named, { recursive: true });
    await writeFile(join(named, "SKILL.md"), "---\nname: named\n---\n本文\n");
    await writeSkill(join(home, ".claude/skills/review"), "review");
    const bundle = join(home, ".claude/skills/synced/bundle");
    await writeSkill(join(bundle, "xlsx"), "xlsx");
    await writeSkill(join(bundle, "pdf"), "pdf");
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({ skills: [] }));
    await writeFile(
      join(home, ".claude/settings.local.json"),
      JSON.stringify({
        skillOverrides: { "anthropic-skills:xlsx": "off", "anthropic-skills:pdf": "on" },
      }),
    );

    const view = await loadAgentSkills("claude", home, NO_ENV);

    expect(view.skills).toEqual([
      { name: "named", source: "~/.claude/skills", state: "on", description: null },
      { name: "pdf", source: "~/.claude/skills/synced", state: "on", description: "説明" },
      { name: "review", source: "~/.claude/skills", state: "on", description: "説明" },
      { name: "xlsx", source: "~/.claude/skills/synced", state: "off", description: "説明" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude は CLAUDE_CONFIG_DIR を読む", async () => {
  const home = await tempHome();
  try {
    const configDir = join(home, "claude-config");
    await writeSkill(join(configDir, "skills/review"), "review");
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({ skillOverrides: { review: "off" } }),
    );

    const view = await loadAgentSkills("claude", home, { CLAUDE_CONFIG_DIR: configDir });

    expect(view.skills).toEqual([
      { name: "review", source: "~/.claude/skills", state: "off", description: "説明" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex は config.toml の name 指定でスキルを無効にする", () => {
  const rules = parseCodexSkillRules(`
[[skills.config]]
name = "xlsx"
enabled = false

[[skills.config]]
path = "/home/example/.agents/skills/gh/SKILL.md"
enabled = false
`);
  expect(rules).toEqual([
    { path: null, name: "xlsx", enabled: false },
    { path: "/home/example/.agents/skills/gh/SKILL.md", name: null, enabled: false },
  ]);
});

test("Codex は ~/.agents/skills を読み、config.toml の設定を反映する", async () => {
  const home = await tempHome();
  try {
    await writeSkill(join(home, ".agents/skills/xlsx"), "xlsx");
    await writeSkill(join(home, ".agents/skills/gh"), "gh");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex/config.toml"),
      '[[skills.config]]\nname = "xlsx"\nenabled = false\n',
    );

    const view = await loadAgentSkills("codex", home, NO_ENV);

    expect(view.skills).toEqual([
      { name: "gh", source: "~/.agents/skills", state: "on", description: "説明" },
      { name: "xlsx", source: "~/.agents/skills", state: "off", description: "説明" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex は symlink 側の path で書いた無効化も実体へ解決して効かせる", async () => {
  const home = await tempHome();
  try {
    const real = join(home, "checkout/skills/gh");
    await writeSkill(real, "gh");
    await mkdir(join(home, ".agents/skills"), { recursive: true });
    const link = join(home, ".agents/skills/gh");
    await symlink(real, link, "dir");
    await mkdir(join(home, ".codex"), { recursive: true });
    // 設定は symlink 側のパスで書く。実体へ解決して照合しないと効かない。
    await writeFile(
      join(home, ".codex/config.toml"),
      `[[skills.config]]\npath = "${join(link, "SKILL.md")}"\nenabled = false\n`,
    );

    const view = await loadAgentSkills("codex", home, NO_ENV);

    expect(view.skills).toEqual([
      { name: "gh", source: "~/.agents/skills", state: "off", description: "説明" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenCode はパス由来の ID で選び、登録順の後勝ちで置き場を決める", async () => {
  const home = await tempHome();
  try {
    // 公式の登録順（低い → 高い）: ~/.claude/skills → ~/.agents/skills →
    // ~/.config/opencode/skills → 設定 `skills`。同じ ID は後から登録された方が勝つ。
    await writeSkill(join(home, ".claude/skills/gh"), "gh", "claude");
    await writeSkill(join(home, ".agents/skills/gh"), "gh", "agents");
    await writeSkill(join(home, ".config/opencode/skills/other"), "other");
    await mkdir(join(home, "shared"), { recursive: true });
    await writeSkill(join(home, "shared/gh"), "gh", "settings");
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({ skills: ["./shared"] }),
    );

    const view = await loadAgentSkills("opencode", home, { HOME_UNUSED: home });

    // 設定 `skills` の ./shared は cwd 基準なので読まない。次に強い
    // ~/.config/opencode/skills には gh が無いので、勝つのは ~/.agents/skills。
    expect(view.skills.map((skill) => [skill.name, skill.source])).toEqual([
      ["gh", "~/.agents/skills"],
      ["other", "~/.config/opencode/skills"],
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenCode は ~/.config/opencode/skills を ~/.agents/skills より優先する", async () => {
  const home = await tempHome();
  try {
    await writeSkill(join(home, ".agents/skills/gh"), "gh", "agents");
    await writeSkill(join(home, ".config/opencode/skills/gh"), "gh", "config");

    const view = await loadAgentSkills("opencode", home, NO_ENV);

    expect(view.skills).toEqual([
      { name: "gh", source: "~/.config/opencode/skills", state: "on", description: "config" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenCode は絶対パスの設定 skills を最優先で読む", async () => {
  const home = await tempHome();
  try {
    await writeSkill(join(home, "shared/gh"), "gh", "settings");
    await writeSkill(join(home, ".config/opencode/skills/gh"), "gh", "config");
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({ skills: [join(home, "shared")] }),
    );

    const view = await loadAgentSkills("opencode", home, NO_ENV);

    expect(view.skills).toEqual([
      { name: "gh", source: join(home, "shared"), state: "on", description: "settings" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("一覧が上限を超えたら切ったことを返す", async () => {
  const home = await tempHome();
  try {
    for (let index = 0; index < 201; index += 1) {
      await writeSkill(join(home, ".agents/skills", `s${index}`), `s${index}`);
    }

    const view = await loadAgentSkills("codex", home, NO_ENV);

    expect(view.skills.length).toBe(200);
    expect(view.truncated).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("GET /api/agents/:agent/skills は一覧をキャッシュさせずに返す", async () => {
  const home = await tempHome();
  try {
    await writeSkill(join(home, ".agents/skills/gh"), "gh");
    const { app } = createTestApp({ homeDirectory: home, skillsHome: home });

    const response = await app.request("/api/agents/codex/skills");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      skills: [{ name: "gh", source: "~/.agents/skills", state: "on", description: "説明" }],
      truncated: false,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("GET /api/agents/:agent/skills は未知のエージェントを拒む", async () => {
  const { app } = createTestApp({ homeDirectory: "/home/example" });

  const response = await app.request("/api/agents/unknown/skills");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});
