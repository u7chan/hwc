// Discord の Webhook URL は資格情報。BFF は全文を返さず、クライアントは末尾だけで
// 登録済みを示す。検証と hint は BFF とクライアントで同じものを使う
// （ADR 0076 discord-done-notification）。

export type NotificationScope = "pull-request" | "all";

export const NOTIFICATION_SCOPES: readonly NotificationScope[] = ["pull-request", "all"];

export type NotificationSettings = {
  enabled: boolean;
  scope: NotificationScope;
  discordWebhookUrl: string | null;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  scope: "pull-request",
  discordWebhookUrl: null,
};

export type DiscordWebhookView = {
  configured: boolean;
  // トークン末尾 4 文字。URL 全文は返さない。
  hint: string | null;
};

export type NotificationView = {
  enabled: boolean;
  scope: NotificationScope;
  discord: DiscordWebhookView;
};

export const TEST_NOTIFICATION_CONTENT =
  "hwc のテスト通知です。このチャンネルに完了通知と要対応の通知が届きます。";

// 送信先は Discord の Webhook だけに限る。BFF に任意の URL を POST させないための
// 条件なので、緩めると SSRF の入口になる。
const WEBHOOK_PATH = /^\/api\/webhooks\/([0-9]+)\/([A-Za-z0-9_-]+)$/;
const WEBHOOK_HOST = "discord.com";
const MAX_WEBHOOK_URL_LENGTH = 512;

export function isNotificationScope(value: unknown): value is NotificationScope {
  return typeof value === "string" && (NOTIFICATION_SCOPES as readonly string[]).includes(value);
}

// 受け付けた URL は正規化した形で返す。末尾の空白や既定 port の表記ゆれを残さない。
export function normalizeDiscordWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "" || raw.length > MAX_WEBHOOK_URL_LENGTH) return null;
  if (raw.includes("?") || raw.includes("#") || raw.includes("@")) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== WEBHOOK_HOST) return null;
  // user:pass@ は資格情報を混ぜる入口になる。既定以外の port も受けない。
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (WEBHOOK_PATH.exec(url.pathname) === null) return null;

  return `https://${WEBHOOK_HOST}${url.pathname}`;
}

export function webhookHint(url: string | null): string | null {
  if (url === null) return null;
  const token = WEBHOOK_PATH.exec(new URL(url).pathname)?.[2] ?? "";
  return token === "" ? null : `…${token.slice(-4)}`;
}

// 保存ファイルは壊れていても起動を止めない。項目ごとに既定へ落とし、他の項目は残す。
export function parseNotificationSettings(value: unknown): NotificationSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  const raw = value as Partial<Record<keyof NotificationSettings, unknown>>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    scope: isNotificationScope(raw.scope) ? raw.scope : "pull-request",
    discordWebhookUrl: normalizeDiscordWebhookUrl(raw.discordWebhookUrl),
  };
}

export function toNotificationView(settings: NotificationSettings): NotificationView {
  return {
    enabled: settings.enabled,
    scope: settings.scope,
    discord: {
      configured: settings.discordWebhookUrl !== null,
      hint: webhookHint(settings.discordWebhookUrl),
    },
  };
}

// 応答の形が違えば設定として扱わない。壊れた応答で登録済みの URL を未登録と
// みなして上書きしないよう、クライアントは null を受けて読み込み失敗にする。
export function parseNotificationView(value: unknown): NotificationView | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { enabled?: unknown; scope?: unknown; discord?: unknown };
  if (typeof raw.enabled !== "boolean" || !isNotificationScope(raw.scope)) return null;
  if (typeof raw.discord !== "object" || raw.discord === null) return null;
  const discord = raw.discord as { configured?: unknown; hint?: unknown };
  if (typeof discord.configured !== "boolean") return null;
  if (discord.hint !== null && typeof discord.hint !== "string") return null;
  return {
    enabled: raw.enabled,
    scope: raw.scope,
    discord: { configured: discord.configured, hint: discord.hint ?? null },
  };
}
