// 設定画面に出す、エージェントがグローバルに認識するスキル。探索は BFF が行い、
// ここには表示に要る形だけを置く（docs/adr/agent-skills.md）。
export type AgentSkillState = "on" | "off";

export type AgentSkill = {
  name: string;
  source: string;
  state: AgentSkillState;
  // frontmatter の description。長いものは BFF で切る。無い・空なら null。
  description: string | null;
};

export type AgentSkills = {
  skills: AgentSkill[];
  // 上限で切ったか。黙って一部だけ見せない。
  truncated: boolean;
};
