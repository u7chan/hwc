import type { AgentSkill } from "../../shared/agent-skills";

export type SkillGroup = { source: string; skills: AgentSkill[] };

// 由来ごとにまとめる。由来は文字順に並べ、中は BFF が返した名前順のまま保つ。
// 由来を行ごとに繰り返すと、同じ置き場の数十行が同じ文字列で埋まる。
export function groupSkillsBySource(skills: AgentSkill[]): SkillGroup[] {
  const bySource = new Map<string, AgentSkill[]>();
  for (const skill of skills) {
    const group = bySource.get(skill.source);
    if (group === undefined) bySource.set(skill.source, [skill]);
    else group.push(skill);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, grouped]) => ({ source, skills: grouped }));
}
