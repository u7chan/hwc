import { expect, test } from "bun:test";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeDiscordWebhookUrl,
  parseNotificationSettings,
  parseNotificationView,
  toNotificationView,
  webhookHint,
} from "./notifications";

const WEBHOOK = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz-ABCD_1234";

test("a Discord webhook URL keeps only the canonical form", () => {
  expect(normalizeDiscordWebhookUrl(WEBHOOK)).toBe(WEBHOOK);
  // 前後の空白は落とし、既定 port の表記ゆれは正規化する。
  expect(normalizeDiscordWebhookUrl(`  ${WEBHOOK}  `)).toBe(WEBHOOK);
  expect(
    normalizeDiscordWebhookUrl(
      "https://discord.com:443/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz-ABCD_1234",
    ),
  ).toBe(WEBHOOK);
});

test("only https discord.com webhook URLs are accepted", () => {
  const invalid = [
    // https だけ
    "http://discord.com/api/webhooks/1234567890/token",
    // ホストは discord.com だけ。別ホスト・サブドメイン・紛らわしい名前は受けない
    "https://discordapp.com/api/webhooks/1234567890/token",
    "https://ptb.discord.com/api/webhooks/1234567890/token",
    "https://discord.com.example.com/api/webhooks/1234567890/token",
    // 認証情報・既定以外の port
    "https://user:pass@discord.com/api/webhooks/1234567890/token",
    "https://discord.com:8443/api/webhooks/1234567890/token",
    // query / fragment は受けない
    "https://discord.com/api/webhooks/1234567890/token?wait=true",
    "https://discord.com/api/webhooks/1234567890/token#fragment",
    // パスの形
    "https://discord.com/api/v10/webhooks/1234567890/token",
    "https://discord.com/api/webhooks/1234567890/",
    "https://discord.com/api/webhooks/1234567890/token/extra",
    // id は数字だけ
    "https://discord.com/api/webhooks/abc/token",
    // token は [A-Za-z0-9_-] だけ
    "https://discord.com/api/webhooks/1234567890/tok.en",
    "https://discord.com/api/webhooks/1234567890/tok=en",
    "",
    "not a url",
  ];
  for (const url of invalid) {
    expect(normalizeDiscordWebhookUrl(url)).toBeNull();
  }
  expect(normalizeDiscordWebhookUrl(null)).toBeNull();
  expect(normalizeDiscordWebhookUrl(1234)).toBeNull();
});

test("a webhook URL longer than the limit is rejected", () => {
  const long = `https://discord.com/api/webhooks/1234567890/${"a".repeat(600)}`;
  expect(normalizeDiscordWebhookUrl(long)).toBeNull();
});

test("the hint shows the last four characters of the token", () => {
  expect(webhookHint(WEBHOOK)).toBe("…1234");
  expect(webhookHint(null)).toBeNull();
});

test("a broken settings file falls back per item and keeps the valid items", () => {
  expect(parseNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  expect(
    parseNotificationSettings({ enabled: "yes", scope: "review", discordWebhookUrl: "http://x" }),
  ).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  expect(
    parseNotificationSettings({
      enabled: true,
      scope: "all",
      discordWebhookUrl: "http://not-discord.example/api/webhooks/1/token",
    }),
  ).toEqual({ enabled: true, scope: "all", discordWebhookUrl: null });
  expect(
    parseNotificationSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK }),
  ).toEqual({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
});

test("the API view hides the URL and shows only the hint", () => {
  const view = toNotificationView({
    enabled: true,
    scope: "pull-request",
    discordWebhookUrl: WEBHOOK,
  });
  // URL 全文は応答に含めない。資格情報なので、末尾 4 文字だけで登録済みを示す。
  expect(view).toEqual({
    enabled: true,
    scope: "pull-request",
    discord: { configured: true, hint: "…1234" },
  });
  expect(JSON.stringify(view)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(toNotificationView(DEFAULT_NOTIFICATION_SETTINGS).discord).toEqual({
    configured: false,
    hint: null,
  });
});

test("a malformed notification response is rejected instead of read as unregistered", () => {
  const view = toNotificationView({ enabled: false, scope: "all", discordWebhookUrl: WEBHOOK });
  expect(parseNotificationView(view)).toEqual(view);
  expect(parseNotificationView({ enabled: false, scope: "all" })).toBeNull();
  expect(
    parseNotificationView({ enabled: false, scope: "review", discord: { configured: false } }),
  ).toBeNull();
  expect(
    parseNotificationView({
      enabled: "no",
      scope: "all",
      discord: { configured: false, hint: null },
    }),
  ).toBeNull();
  expect(
    parseNotificationView({ enabled: true, scope: "all", discord: { configured: true, hint: 1 } }),
  ).toBeNull();
  expect(parseNotificationView(null)).toBeNull();
});
