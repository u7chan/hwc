import { expect, test } from "bun:test";
import {
  canRegisterWebhook,
  saveNotificationText,
  testNotificationText,
  webhookHintText,
} from "./notifications";

const WEBHOOK = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwx-1234";

test("the register button only enables for a valid Discord webhook URL", () => {
  expect(canRegisterWebhook(WEBHOOK)).toBe(true);
  expect(canRegisterWebhook(`  ${WEBHOOK}  `)).toBe(true);
  // 形式が正しくないまま保存させない。BFF でも同じ検証で弾く。
  expect(canRegisterWebhook("")).toBe(false);
  expect(canRegisterWebhook("https://example.com/hook")).toBe(false);
  expect(canRegisterWebhook("http://discord.com/api/webhooks/1/token")).toBe(false);
});

test("the test result is explained by the error code", () => {
  expect(testNotificationText({ ok: true })).toContain("テスト通知を送信しました");
  // BFF の 404 と Discord の 404 を取り違えない。文言はコードで決める。
  expect(testNotificationText({ ok: false, error: "webhook_not_configured" })).toBe(
    "Webhook URL が登録されていません。",
  );
  expect(testNotificationText({ ok: false, error: "discord_invalid_webhook" })).toBe(
    "Webhook URL が無効です。URL を確認して登録し直してください。",
  );
  expect(testNotificationText({ ok: false, error: "discord_rate_limited" })).toBe(
    "Discord が混み合っています。少し待って再試行してください。",
  );
  expect(testNotificationText({ ok: false, error: "discord_unavailable" })).toBe(
    "Discord に送信できませんでした。ネットワークを確認してください。",
  );
  // BFF に届かなかった・期限を過ぎた場合はコードが無い。
  expect(testNotificationText({ ok: false, error: "unreachable" })).toBe(
    "hwc から応答がありませんでした。少し待って再試行してください。",
  );
  expect(testNotificationText({ ok: false, error: "unknown" })).toBe(
    "テスト通知を送信できませんでした。",
  );
});

test("the registered webhook shows the label with the hint", () => {
  // 登録済みでも URL 全文は出さない。ラベルと末尾 4 文字だけを並べる。
  expect(webhookHintText("…a1b2")).toBe("Webhook URL  …a1b2");
  expect(webhookHintText(null)).toBe("");
});

test("the save failure is explained by the error code", () => {
  expect(saveNotificationText("invalid_webhook_url")).toBe(
    "Webhook URL の形式が正しくありません。",
  );
  expect(saveNotificationText("invalid_request")).toBe("入力内容を確認してください。");
  expect(saveNotificationText("settings_unavailable")).toBe(
    "設定を保存できませんでした。もう一度お試しください。",
  );
  // 応答を読めなかった場合も、未登録と決めつけずに失敗として伝える。
  expect(saveNotificationText(null)).toBe("設定を保存できませんでした。");
});
