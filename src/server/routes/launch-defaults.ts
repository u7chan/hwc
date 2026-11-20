import { supportsModelSelection } from "../../shared/agents";
import { parseLaunchDefault } from "../../shared/launch-defaults";
import type { AppContext, PlainContext } from "./context";

export function createLaunchDefaultsHandlers(ctx: AppContext) {
  const { launchDefaults } = ctx;

  return {
    get: (c: PlainContext) => {
      // 設定画面と作成ダイアログが開くたびに読む。共有キャッシュに残さない。
      c.header("cache-control", "no-store");
      return c.json({ defaults: launchDefaults.get() });
    },
    put: async (c: PlainContext) => {
      const body = await c.req.json().catch(() => null);
      if (typeof body !== "object" || body === null) {
        return c.json({ error: "invalid_request" }, 400);
      }
      const { agent, value } = body as { agent?: unknown; value?: unknown };
      if (!supportsModelSelection(agent)) return c.json({ error: "invalid_request" }, 400);
      const parsed = value === null ? null : parseLaunchDefault(value);
      if (value !== null && parsed === null) return c.json({ error: "invalid_request" }, 400);
      try {
        launchDefaults.set(agent, parsed);
      } catch {
        // メモリ上の既定は変えない。画面には古い既定が残る。
        return c.json({ error: "settings_unavailable" }, 500);
      }
      return c.json({ defaults: launchDefaults.get() });
    },
  };
}
