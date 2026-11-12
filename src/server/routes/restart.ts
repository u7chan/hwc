import type { AppContext, PlainContext } from "./context";

export function createRestartHandlers(ctx: AppContext) {
  const { restartSettings, restart, scheduleRestart, parseRestartUpdate } = ctx;

  return {
    get: (c: PlainContext) => {
      // 設定画面だけが読む。実行ファイルのパスを共有キャッシュに残さない。
      c.header("cache-control", "no-store");
      return c.json(restartSettings.get());
    },
    put: async (c: PlainContext) => {
      const parsed = parseRestartUpdate(await c.req.json().catch(() => null));
      if (parsed === null) return c.json({ error: "invalid_request" }, 400);
      try {
        restartSettings.save(parsed);
      } catch {
        // メモリ上の設定は変えない。画面には古い設定が残る。
        return c.json({ error: "settings_unavailable" }, 500);
      }
      return c.json(restartSettings.get());
    },
    run: (c: PlainContext) => {
      const command = restartSettings.get().command;
      if (command === null) return c.json({ error: "command_not_configured" }, 409);
      if (!restart.isExecutable(command)) return c.json({ error: "command_not_executable" }, 409);
      // 手元からの再起動は、BFF が動いているチェックアウトを対象にする。
      scheduleRestart(command, process.cwd());
      return c.json({ ok: true }, 202);
    },
  };
}
