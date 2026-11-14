import { parseTemplates } from "../../shared/templates";
import type { AppContext, PlainContext } from "./context";

export function createTemplatesHandlers(ctx: AppContext) {
  const { templates } = ctx;

  return {
    get: (c: PlainContext) => {
      // 設定画面と入力欄のダイアログだけが読む。共有キャッシュに残さない。
      c.header("cache-control", "no-store");
      return c.json({ templates: templates.get() });
    },
    put: async (c: PlainContext) => {
      const body = await c.req.json().catch(() => null);
      const raw =
        typeof body === "object" && body !== null
          ? (body as { templates?: unknown }).templates
          : undefined;
      const parsed = parseTemplates(raw);
      if (parsed === null) return c.json({ error: "invalid_request" }, 400);
      try {
        templates.save(parsed);
      } catch {
        // メモリ上の一覧は変えない。画面には古い一覧が残る。
        return c.json({ error: "settings_unavailable" }, 500);
      }
      return c.json({ templates: templates.get() });
    },
  };
}
