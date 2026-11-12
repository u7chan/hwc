import { useEffect, useState } from "preact/hooks";
import type { NotificationScope, NotificationView } from "../shared/notifications";
import {
  fetchNotifications,
  removeDiscordWebhook,
  saveDiscordWebhook,
  saveNotificationSettings,
  testDiscordWebhook,
  type NotificationSaveResult,
  type NotificationTestResult,
} from "./api";
import { Confirm } from "./Confirm";
import { DiscordIcon } from "./icons";
import {
  canRegisterWebhook,
  saveNotificationText,
  testNotificationText,
  webhookHintText,
} from "./notifications";

type LoadState = "loading" | "ready" | "failed";

const SCOPE_OPTIONS: ReadonlyArray<{ scope: NotificationScope; title: string; note: string }> = [
  {
    scope: "pull-request",
    title: "PR がある作業だけ",
    note: "ブランチの最新 PR が open のスペースの完了を通知",
  },
  {
    scope: "all",
    title: "すべての作業",
    note: "PR のない調査や雑務の完了も通知",
  },
];

// 設定は BFF が正。変更後の応答でスナップショットを丸ごと置き換え、同時操作で
// トグル・scope・URL が食い違わないようにする。
export function NotificationSettings() {
  const [view, setView] = useState<NotificationView | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  // 変更中は空の入力から始める。登録済みの URL は BFF から受け取らない。
  const [editing, setEditing] = useState<"none" | "new" | "change">("none");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NotificationTestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoad("loading");
    fetchNotifications(controller.signal).then(
      (next) => {
        setView(next);
        setLoad("ready");
      },
      () => {
        // 読み込めないまま「未登録」と出すと、既存の URL を意図せず上書きする。
        if (!controller.signal.aborted) setLoad("failed");
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  const applySave = (result: NotificationSaveResult): boolean => {
    if (result.ok) {
      setView(result.view);
      setMessage(null);
      return true;
    }
    setMessage(saveNotificationText(result.error));
    return false;
  };

  const save = async (next: { enabled: boolean; scope: NotificationScope }) => {
    if (busy || view === null) return;
    setBusy(true);
    applySave(await saveNotificationSettings(next));
    setBusy(false);
  };

  const submitWebhook = async () => {
    if (busy || !canRegisterWebhook(url)) return;
    setBusy(true);
    const saved = applySave(await saveDiscordWebhook(url.trim()));
    if (saved) {
      setEditing("none");
      setUrl("");
      setTestResult(null);
    }
    setBusy(false);
  };

  const deleteWebhook = async () => {
    setConfirmDelete(false);
    if (busy) return;
    setBusy(true);
    const saved = applySave(await removeDiscordWebhook());
    if (saved) {
      setTestResult(null);
      setEditing("none");
      setUrl("");
    }
    setBusy(false);
  };

  const sendTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(await testDiscordWebhook());
    setTesting(false);
  };

  return (
    <section class="hwc-section">
      <h3 class="hwc-section-title">通知</h3>

      {load === "loading" ? (
        <p class="hwc-section-note">通知の設定を読み込んでいます。</p>
      ) : load === "failed" || view === null ? (
        <div class="hwc-setting-failure">
          <p class="hwc-section-note" role="alert">
            通知の設定を読み込めませんでした。
          </p>
          <button
            type="button"
            class="hwc-setting-button"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            再試行
          </button>
        </div>
      ) : (
        <>
          <div class="hwc-setting-group">
            <div class="hwc-setting-row">
              <span class="hwc-setting-label">Discord へ通知</span>
              <button
                type="button"
                role="switch"
                class="hwc-switch"
                aria-checked={view.enabled}
                aria-label="Discord へ通知"
                data-on={view.enabled}
                disabled={busy}
                onClick={() => void save({ enabled: !view.enabled, scope: view.scope })}
              >
                <span class="hwc-switch-knob" />
              </button>
            </div>
          </div>
          <p class="hwc-section-note">
            司令塔が完了し、ほかのエージェントが動いていないときに完了を 1
            回だけ送ります。通知中は、要対応になったときも対象に関係なくその場で送ります。Herdr
            の状態を受け取った時点で判定します。
          </p>

          <p class="hwc-notify-subtitle">完了通知の対象</p>
          <div class="hwc-notify-scopes" role="radiogroup" aria-label="完了通知の対象">
            {SCOPE_OPTIONS.map((option) => (
              <button
                key={option.scope}
                type="button"
                role="radio"
                class="hwc-notify-scope"
                aria-checked={view.scope === option.scope}
                data-selected={view.scope === option.scope}
                disabled={busy}
                onClick={() => void save({ enabled: view.enabled, scope: option.scope })}
              >
                <span class="hwc-notify-scope-mark" aria-hidden="true" />
                <span class="hwc-notify-scope-text">
                  <span class="hwc-notify-scope-title">{option.title}</span>
                  <span class="hwc-notify-scope-note">{option.note}</span>
                </span>
              </button>
            ))}
          </div>
          <p class="hwc-section-note">要対応の通知は、この対象に関係なく送ります。</p>

          <div class="hwc-notify-discord">
            <div class="hwc-notify-discord-head">
              <span class="hwc-notify-discord-mark">
                <DiscordIcon size={18} />
              </span>
              <span class="hwc-notify-discord-name">Discord</span>
              <span class="hwc-notify-discord-state">
                {view.discord.configured ? "登録済み" : "未登録"}
              </span>
            </div>

            {view.discord.configured ? (
              <p class="hwc-notify-hint">{webhookHintText(view.discord.hint)}</p>
            ) : null}

            {editing !== "none" || !view.discord.configured ? (
              <form
                class="hwc-setting-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitWebhook();
                }}
              >
                <input
                  type="url"
                  class="hwc-setting-input"
                  inputmode="url"
                  autocomplete="off"
                  spellcheck={false}
                  aria-label="Webhook URL"
                  placeholder="https://discord.com/api/webhooks/…"
                  value={url}
                  disabled={busy}
                  onInput={(event) => setUrl(event.currentTarget.value)}
                />
                <div class="hwc-setting-actions">
                  <button
                    type="submit"
                    class="hwc-setting-button hwc-setting-primary"
                    disabled={busy || !canRegisterWebhook(url)}
                  >
                    {view.discord.configured ? "保存" : "登録"}
                  </button>
                  {view.discord.configured ? (
                    <button
                      type="button"
                      class="hwc-setting-button"
                      disabled={busy}
                      onClick={() => {
                        setEditing("none");
                        setUrl("");
                        setMessage(null);
                      }}
                    >
                      キャンセル
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <div class="hwc-setting-actions">
                <button
                  type="button"
                  class="hwc-setting-button"
                  disabled={busy || testing}
                  onClick={() => void sendTest()}
                >
                  {testing ? "送信中…" : "テスト通知"}
                </button>
                <button
                  type="button"
                  class="hwc-setting-button"
                  disabled={busy || testing}
                  onClick={() => {
                    setEditing("change");
                    setUrl("");
                    setMessage(null);
                  }}
                >
                  変更
                </button>
                <button
                  type="button"
                  class="hwc-setting-button"
                  disabled={busy || testing}
                  onClick={() => setConfirmDelete(true)}
                >
                  削除
                </button>
              </div>
            )}

            {testResult === null ? null : (
              <p class="hwc-setting-result" data-ok={testResult.ok} role="status">
                {testNotificationText(testResult)}
              </p>
            )}
            {message === null ? null : (
              <p class="hwc-setting-result" data-ok={false} role="alert">
                {message}
              </p>
            )}
          </div>

          <p class="hwc-section-note">
            Webhook URL は hwc のサーバーに保存します。ブラウザを閉じても通知は届きます。
          </p>
        </>
      )}

      {confirmDelete ? (
        <Confirm
          title="Webhook URL を削除"
          description="Discord への通知は届かなくなります。通知の有効・無効は変わりません。"
          confirmLabel="削除"
          busy={busy}
          onConfirm={() => void deleteWebhook()}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </section>
  );
}
