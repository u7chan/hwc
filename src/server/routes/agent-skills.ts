import { supportsModelSelection } from "../../shared/agents";
import { loadAgentSkills } from "../agent-skills";
import type { AppContext, PlainContext } from "./context";

export function createAgentSkillsHandlers(ctx: AppContext) {
  const { skillsHome } = ctx;

  return {
    get: async (c: PlainContext) => {
      const agent = c.req.param("agent");
      if (!supportsModelSelection(agent)) return c.json({ error: "invalid_request" }, 400);
      // ホームのファイルは設定画面を開くたびに読み直す。共有キャッシュに残さない。
      c.header("cache-control", "no-store");
      return c.json(await loadAgentSkills(agent, skillsHome));
    },
  };
}
