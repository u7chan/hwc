import { expect, test } from "bun:test";
import type { AgentSkill } from "../../shared/agent-skills";
import { groupSkillsBySource } from "./skill-groups";

const skill = (name: string, source: string): AgentSkill => ({
  name,
  source,
  state: "on",
  description: null,
});

test("スキルを由来ごとにまとめ、由来は文字順に並べる", () => {
  const groups = groupSkillsBySource([
    skill("deploy-check", "~/.pi/agent/skills"),
    skill("gh", "~/.agents/skills"),
    skill("imagegen", "~/.claude/skills"),
  ]);

  expect(groups.map((group) => group.source)).toEqual([
    "~/.agents/skills",
    "~/.claude/skills",
    "~/.pi/agent/skills",
  ]);
});

test("由来の中では、受け取った名前順を崩さない", () => {
  const groups = groupSkillsBySource([
    skill("deploy-check", "~/.agents/skills"),
    skill("imagegen", "~/.claude/skills"),
    skill("review", "~/.agents/skills"),
  ]);

  expect(groups[0]?.skills.map((entry) => entry.name)).toEqual(["deploy-check", "review"]);
  expect(groups[1]?.skills.map((entry) => entry.name)).toEqual(["imagegen"]);
});

test("スキルが無ければグループも無い", () => {
  expect(groupSkillsBySource([])).toEqual([]);
});
