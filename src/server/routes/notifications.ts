import {
  isNotificationScope,
  TEST_NOTIFICATION_CONTENT,
  normalizeDiscordWebhookUrl,
  toNotificationView,
  type NotificationSettings,
} from "../../shared/notifications";
import type { AppContext, PlainContext } from "./context";

export function createNotificationsHandlers(ctx: AppContext) {
  const { notificationSettings, discordSender } = ctx;

  // 通知設定は 1 つのストアに集約する。トグル・scope・URL が同時に変わっても、
  // 書き込みが成功した設定だけを返し、クライアントは応答で丸ごと置き換える。
  const notificationView = () => toNotificationView(notificationSettings.get());

  const saveNotificationSettings = (c: PlainContext, next: NotificationSettings) => {
    try {
      notificationSettings.save(next);
    } catch {
      // メモリ上の設定は変えない。画面には古い設定が残る。
      return c.json({ error: "settings_unavailable" }, 500);
    }
    return c.json(notificationView());
  };

  const parseNotificationUpdate = (
    body: unknown,
  ): Pick<NotificationSettings, "enabled" | "scope"> | null => {
    if (typeof body !== "object" || body === null) return null;
    const raw = body as { enabled?: unknown; scope?: unknown };
    if (typeof raw.enabled !== "boolean" || !isNotificationScope(raw.scope)) return null;
    return { enabled: raw.enabled, scope: raw.scope };
  };

  return {
    get: (c: PlainContext) => {
      // Webhook URL は資格情報。共有キャッシュに残さない。
      c.header("cache-control", "no-store");
      return c.json(notificationView());
    },
    put: async (c: PlainContext) => {
      const parsed = parseNotificationUpdate(await c.req.json().catch(() => null));
      if (parsed === null) return c.json({ error: "invalid_request" }, 400);
      return saveNotificationSettings(c, { ...notificationSettings.get(), ...parsed });
    },
    putDiscord: async (c: PlainContext) => {
      const body = await c.req.json().catch(() => null);
      const raw =
        typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
      if (typeof raw !== "string") return c.json({ error: "invalid_request" }, 400);
      // 保存前に必ず再検証する。設定ファイルを手で書き換えられても、ここを通らない限り送らない。
      const url = normalizeDiscordWebhookUrl(raw);
      if (url === null) return c.json({ error: "invalid_webhook_url" }, 400);
      return saveNotificationSettings(c, {
        ...notificationSettings.get(),
        discordWebhookUrl: url,
      });
    },
    deleteDiscord: (c: PlainContext) =>
      // 有効トグルは変えない。URL を消しても通知の設定は残す。
      saveNotificationSettings(c, { ...notificationSettings.get(), discordWebhookUrl: null }),
    testDiscord: async (c: PlainContext) => {
      const url = notificationSettings.get().discordWebhookUrl;
      if (url === null) return c.json({ error: "webhook_not_configured" }, 409);
      // 疎通確認を先に行えるよう、有効・無効と scope に依存させない。応答は送信完了後。
      const result = await discordSender(url, TEST_NOTIFICATION_CONTENT);
      if (result.ok) return c.json({ ok: true });
      const body: { error: string; retryAfter?: number } = { error: result.error };
      if (result.retryAfter !== undefined) body.retryAfter = result.retryAfter;
      return c.json(body, 502);
    },
  };
}
