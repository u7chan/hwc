import { useEffect, useState } from "preact/hooks";
import type { RestartSettings } from "../shared/restart";
import {
  fetchRestartSettings,
  runRestart,
  saveRestartSettings,
  type RestartSaveResult,
  type RunRestartResult,
} from "./api";

type LoadState = "loading" | "ready" | "failed";

const RUN_TEXT: Record<RunRestartResult, { ok: boolean; text: string }> = {
  started: { ok: true, text: "再起動コマンドを起動しました。" },
  not_configured: { ok: false, text: "再起動コマンドが設定されていません。" },
  not_executable: {
    ok: false,
    text: "コマンドを実行できませんでした。パスと実行権限を確かめてください。",
  },
  unreachable: {
    ok: false,
    text: "サーバーから応答がありませんでした。再読み込みして確かめてください。",
  },
};

function saveText(error: string | null): string {
  if (error === "invalid_request") return "実行ファイルの絶対パスを指定してください。";
  return "設定を保存できませんでした。";
}

// 設定は BFF が正。変更後の応答でスナップショットを丸ごと置き換える。
export function RestartSettings() {
  const [view, setView] = useState<RestartSettings | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  // 入力欄は保存済みの値から始め、打ち直したときだけ下書きを持つ。
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad("loading");
    fetchRestartSettings(controller.signal).then(
      (next) => {
        setView(next);
        setLoad("ready");
      },
      () => {
        // 読み込めないまま「未設定」と出すと、既存の設定を意図せず上書きする。
        if (!controller.signal.aborted) setLoad("failed");
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  const applySave = (saved: RestartSaveResult): boolean => {
    if (saved.ok) {
      setView(saved.view);
      setDraft(null);
      setMessage(null);
      return true;
    }
    setMessage(saveText(saved.error));
    return false;
  };

  const save = async (command: string | null, afterPull: boolean) => {
    if (busy) return;
    setBusy(true);
    applySave(await saveRestartSettings({ command, afterPull }));
    setBusy(false);
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setResult(RUN_TEXT[await runRestart()]);
    setBusy(false);
  };

  const saved = view?.command ?? "";
  const shown = draft ?? saved;

  return (
    <section class="hwc-section">
      <h3 class="hwc-section-title">再起動</h3>

      {load === "loading" ? (
        <p class="hwc-section-note">再起動の設定を読み込んでいます。</p>
      ) : load === "failed" || view === null ? (
        <div class="hwc-setting-failure">
          <p class="hwc-section-note" role="alert">
            再起動の設定を読み込めませんでした。
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
              <span class="hwc-setting-label">プル成功後に実行</span>
              <button
                type="button"
                role="switch"
                class="hwc-switch"
                aria-checked={view.afterPull}
                aria-label="プル成功後に実行"
                data-on={view.afterPull}
                disabled={busy}
                onClick={() => void save(view.command, !view.afterPull)}
              >
                <span class="hwc-switch-knob" />
              </button>
            </div>
          </div>

          <form
            class="hwc-setting-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(shown.trim() === "" ? null : shown.trim(), view.afterPull);
            }}
          >
            <input
              type="text"
              class="hwc-setting-input"
              autocomplete="off"
              spellcheck={false}
              aria-label="再起動コマンドのパス"
              placeholder="/usr/local/bin/restart-hwc"
              value={shown}
              disabled={busy}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
            <div class="hwc-setting-actions">
              <button
                type="submit"
                class="hwc-setting-button hwc-setting-primary"
                disabled={busy || shown.trim() === saved}
              >
                保存
              </button>
              <button
                type="button"
                class="hwc-setting-button"
                disabled={busy || view.command === null}
                onClick={() => void run()}
              >
                今すぐ再起動
              </button>
            </div>
          </form>

          <p class="hwc-section-note">
            実行ファイルの絶対パスを、シェルを介さずに起動します。プル成功後に実行すると、マージの反映と再起動をまとめて行えます。対象のリポジトリを絞るときは、コマンド側で
            <code>git rev-parse --show-toplevel</code> などを見て判定してください。
          </p>

          {result === null ? null : (
            <p class="hwc-setting-result" data-ok={result.ok} role="status">
              {result.text}
            </p>
          )}
          {message === null ? null : (
            <p class="hwc-setting-result" data-ok={false} role="alert">
              {message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
