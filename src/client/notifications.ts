import { normalizeDiscordWebhookUrl } from "../shared/notifications";
import type { NotificationTestResult } from "./api";

// 形式が正しいときだけ登録できる。BFF でも同じ検証を通す。
export function canRegisterWebhook(url: string): boolean {
  return normalizeDiscordWebhookUrl(url) !== null;
}

export function testNotificationText(result: NotificationTestResult): string {
  if (result.ok) return "テスト通知を送信しました。Discord のチャンネルを確認してください。";
  switch (result.error) {
    case "webhook_not_configured":
      return "Webhook URL が登録されていません。";
    case "discord_invalid_webhook":
      return "Webhook URL が無効です。URL を確認して登録し直してください。";
    case "discord_rate_limited":
      return "Discord が混み合っています。少し待って再試行してください。";
    case "discord_unavailable":
      return "Discord に送信できませんでした。ネットワークを確認してください。";
    // BFF に届かなかった・期限を過ぎた。応答のコードが無いのでここで文言を決める。
    case "unreachable":
      return "hwc から応答がありませんでした。少し待って再試行してください。";
    default:
      return "テスト通知を送信できませんでした。";
  }
}

export function saveNotificationText(error: string | null): string {
  switch (error) {
    case "invalid_webhook_url":
      return "Webhook URL の形式が正しくありません。";
    case "invalid_request":
      return "入力内容を確認してください。";
    case "settings_unavailable":
      return "設定を保存できませんでした。もう一度お試しください。";
    default:
      return "設定を保存できませんでした。";
  }
}

export function webhookHintText(hint: string | null): string {
  return hint === null ? "" : `Webhook URL  ${hint}`;
}
