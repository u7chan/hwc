import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp } from "./app.test-helpers";
import { loadAgentSkills, parseCodexSkillRules, parseSkillFrontmatter } from "./agent-skills";

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "hwc-skills-"));
}

async function writeSkill(path: string, name: string, description = "説明"): Promise<void> {
  await mkdir(path, { recursive: true });
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n\n本文\n`;
  await writeFile(join(path, "SKILL.md"), frontmatter);
}

test("frontmatter から name と description の有無を読む", () => {
  expect(parseSkillFrontmatter("---\nname: gh\ndescription: x\n---\n")).toEqual({
    name: "gh",
    described: true,
  });
  // description が無いスキルは Pi / Codex が読み込まない。
  expect(parseSkillFrontmatter("---\nname: gh\n---\n")).toEqual({ name: "gh", described: false });
  expect(parseSkillFrontmatter("# 見出しだけ")).toEqual({ name: null, described: false });
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

    const view = await loadAgentSkills("pi", home);

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

test("Claude はバンドルのスキルを skillOverrides の名前空間で無効にする", async () => {
  const home = await tempHome();
  try {
    await writeSkill(join(home, ".claude/skills/review"), "review");
    const bundle = join(home, ".claude/skills/synced/bundle");
    await writeSkill(join(bundle, "xlsx"), "xlsx");
    await writeSkill(join(bundle, "pdf"), "pdf");
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({ skills: [] }));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude/settings.local.json"),
      JSON.stringify({
        skillOverrides: { "anthropic-skills:xlsx": "off", "anthropic-skills:pdf": "on" },
      }),
    );

    const view = await loadAgentSkills("claude", home);

    expect(view.skills).toEqual([
      { name: "pdf", source: "~/.claude/skills/synced", state: "on" },
      { name: "review", source: "~/.claude/skills", state: "on" },
      { name: "xlsx", source: "~/.claude/skills/synced", state: "off" },
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

    const view = await loadAgentSkills("codex", home);

    expect(view.skills).toEqual([
      { name: "gh", source: "~/.agents/skills", state: "on" },
      { name: "xlsx", source: "~/.agents/skills", state: "off" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenCode は互換の置き場を重複させず、ルート直下の .md も読む", async () => {
  const home = await tempHome();
  try {
    await writeSkill(join(home, ".agents/skills/gh"), "gh");
    await mkdir(join(home, ".claude"), { recursive: true });
    await symlink(join(home, ".agents/skills"), join(home, ".claude/skills"), "dir");
    await mkdir(join(home, ".config/opencode/skills"), { recursive: true });
    await writeFile(
      join(home, ".config/opencode/skills/note.md"),
      "---\nname: note\ndescription: x\n---\n",
    );

    const view = await loadAgentSkills("opencode", home);

    expect(view.skills.map((skill) => [skill.name, skill.source])).toEqual([
      ["gh", "~/.claude/skills"],
      ["note", "~/.config/opencode/skills"],
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

    const view = await loadAgentSkills("codex", home);

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
    const { app } = createTestApp({ homeDirectory: home });

    const response = await app.request("/api/agents/codex/skills");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      skills: [{ name: "gh", source: "~/.agents/skills", state: "on" }],
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
