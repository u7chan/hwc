import { expect, test } from "bun:test";
import { createApp } from "./app";
import {
  type NotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
  TEST_NOTIFICATION_CONTENT,
} from "../shared/notifications";
import type { DiscordSendResult, DiscordSender, NotificationSettingsStore } from "./notifications";
import { createTestApp } from "./app.test-helpers";

const NOTIFICATION_WEBHOOK =
  "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwx-1234";

function createFakeNotificationSettings(initial: Partial<NotificationSettings> = {}) {
  let current: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...initial };
  const saves: NotificationSettings[] = [];
  const store: NotificationSettingsStore = {
    get: () => current,
    save: (next) => {
      saves.push(next);
      current = next;
    },
  };
  return { store, saves, current: () => current };
}

function createFakeDiscordSender(result: DiscordSendResult) {
  const calls: Array<{ url: string; content: string }> = [];
  const sender: DiscordSender = async (url, content) => {
    calls.push({ url, content });
    return result;
  };
  return { sender, calls };
}

function putNotification(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/notifications", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET /api/notifications returns the view without the webhook URL", async () => {
  const { store } = createFakeNotificationSettings({
    enabled: true,
    scope: "all",
    discordWebhookUrl: NOTIFICATION_WEBHOOK,
  });
  const { app } = createTestApp({ notificationSettings: store });

  const response = await app.request("/api/notifications");

  expect(response.status).toBe(200);
  // 資格情報なので、共有キャッシュにも中身にも残さない。
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toEqual({
    enabled: true,
    scope: "all",
    discord: { configured: true, hint: "…1234" },
  });
  expect(JSON.stringify(body)).not.toContain("abcdefghijklmnopqrstuvwx");
});

test("GET /api/notifications reports an unregistered webhook", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/notifications");
  expect(await response.json()).toEqual({
    enabled: false,
    scope: "pull-request",
    discord: { configured: false, hint: null },
  });
});

test("PUT /api/notifications saves the toggle and the scope", async () => {
  const settings = createFakeNotificationSettings();
  const { app } = createTestApp({ notificationSettings: settings.store });

  const response = await putNotification(app, { enabled: true, scope: "all" });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: true,
    scope: "all",
    discord: { configured: false, hint: null },
  });
  // URL は PUT では変わらない。1 つのストアに集約して食い違いを防ぐ。
  expect(settings.saves).toEqual([{ enabled: true, scope: "all", discordWebhookUrl: null }]);
});

test("PUT /api/notifications rejects an incomplete or invalid body", async () => {
  const settings = createFakeNotificationSettings();
  const { app } = createTestApp({ notificationSettings: settings.store });

  for (const body of [
    {},
    { enabled: true },
    { enabled: "yes", scope: "all" },
    { enabled: true, scope: "review" },
    null,
  ]) {
    const response = await putNotification(app, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  }
  expect(settings.saves).toEqual([]);
});

test("PUT /api/notifications requires a JSON body", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/notifications", {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ enabled: true, scope: "all" }),
  });
  expect(response.status).toBe(415);
});

test("PUT /api/notifications/discord stores the normalized URL", async () => {
  const settings = createFakeNotificationSettings();
  const { app } = createTestApp({ notificationSettings: settings.store });

  const response = await app.request("/api/notifications/discord", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `  ${NOTIFICATION_WEBHOOK}  ` }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: false,
    scope: "pull-request",
    discord: { configured: true, hint: "…1234" },
  });
  expect(settings.current().discordWebhookUrl).toBe(NOTIFICATION_WEBHOOK);
});

test("PUT /api/notifications/discord rejects an invalid URL", async () => {
  const settings = createFakeNotificationSettings();
  const { app } = createTestApp({ notificationSettings: settings.store });

  for (const url of [
    "https://example.com/hook",
    "http://discord.com/api/webhooks/1/token",
    "https://discord.com/api/webhooks/1/token?wait=true",
  ]) {
    const response = await app.request("/api/notifications/discord", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_webhook_url" });
  }

  // URL が文字列でない body は、リクエストの形の誤りとして扱う。
  const response = await app.request("/api/notifications/discord", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: 42 }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
  expect(settings.saves).toEqual([]);
});

test("DELETE /api/notifications/discord clears only the URL", async () => {
  const settings = createFakeNotificationSettings({
    enabled: true,
    scope: "all",
    discordWebhookUrl: NOTIFICATION_WEBHOOK,
  });
  const { app } = createTestApp({ notificationSettings: settings.store });

  const response = await app.request("/api/notifications/discord", { method: "DELETE" });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: true,
    scope: "all",
    discord: { configured: false, hint: null },
  });
});

test("a failed save answers settings_unavailable and keeps the old settings", async () => {
  const current: NotificationSettings = {
    enabled: false,
    scope: "pull-request",
    discordWebhookUrl: NOTIFICATION_WEBHOOK,
  };
  const store: NotificationSettingsStore = {
    get: () => current,
    save: () => {
      throw new Error("disk full");
    },
  };
  const { app } = createTestApp({ notificationSettings: store });

  const response = await putNotification(app, { enabled: true, scope: "all" });

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "settings_unavailable" });
  expect(current.enabled).toBe(false);
});

test("POST /api/notifications/discord/test needs a saved webhook", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/notifications/discord/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "webhook_not_configured" });
});

test("POST /api/notifications/discord/test sends to the saved URL", async () => {
  const settings = createFakeNotificationSettings({
    // テストは有効・無効と scope に依存させない。疎通確認を先に行える。
    enabled: false,
    scope: "all",
    discordWebhookUrl: NOTIFICATION_WEBHOOK,
  });
  const { sender, calls } = createFakeDiscordSender({ ok: true });
  const { app } = createTestApp({ notificationSettings: settings.store, discordSender: sender });

  const response = await app.request("/api/notifications/discord/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(calls).toEqual([{ url: NOTIFICATION_WEBHOOK, content: TEST_NOTIFICATION_CONTENT }]);
  // 未保存の URL を試す口は無い。body の有無に関わらず保存済み URL に送る。
  expect(settings.saves).toEqual([]);
});

test("POST /api/notifications/discord/test requires a JSON body", async () => {
  const settings = createFakeNotificationSettings({ discordWebhookUrl: NOTIFICATION_WEBHOOK });
  const { app } = createTestApp({ notificationSettings: settings.store });
  const response = await app.request("/api/notifications/discord/test", {
    method: "POST",
    headers: { "content-type": "text/plain" },
  });
  expect(response.status).toBe(415);
});

test("POST /api/notifications/discord/test maps Discord failures to error codes", async () => {
  const cases: Array<[DiscordSendResult, number, unknown]> = [
    [{ ok: false, error: "discord_invalid_webhook" }, 502, { error: "discord_invalid_webhook" }],
    [
      { ok: false, error: "discord_rate_limited", retryAfter: 3 },
      502,
      { error: "discord_rate_limited", retryAfter: 3 },
    ],
    [{ ok: false, error: "discord_unavailable" }, 502, { error: "discord_unavailable" }],
  ];
  for (const [result, status, body] of cases) {
    const settings = createFakeNotificationSettings({ discordWebhookUrl: NOTIFICATION_WEBHOOK });
    const { sender } = createFakeDiscordSender(result);
    const { app } = createTestApp({
      notificationSettings: settings.store,
      discordSender: sender,
    });
    const response = await app.request("/api/notifications/discord/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  }
});
