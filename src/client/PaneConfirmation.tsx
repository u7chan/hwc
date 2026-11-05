import { useEffect, useRef, useState } from "preact/hooks";
import type { PaneInteraction } from "../shared/confirmation";
import { confirmFolderTrust } from "./api";
import { StatusMark } from "./icons";
import { Spinner } from "./Spinner";

export function PaneConfirmation(props: {
  paneId: string;
  confirmation: Extract<PaneInteraction, { kind: "codex-folder-trust" }>;
  onDismiss: () => void;
}) {
  const [attempt, setAttempt] = useState<"idle" | "sending" | "waiting" | "failed">("idle");
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    return () => request.current?.abort();
  }, []);

  const accept = async () => {
    if (request.current !== null || props.confirmation.submitted) return;
    const controller = new AbortController();
    request.current = controller;
    setAttempt("sending");
    try {
      await confirmFolderTrust(props.paneId, props.confirmation.id, controller.signal);
      if (!controller.signal.aborted) setAttempt("waiting");
    } catch {
      if (!controller.signal.aborted) setAttempt("failed");
    }
  };
  const waiting = attempt === "waiting" || props.confirmation.submitted;

  return (
    <section class="hwc-confirmation" aria-label="Codex のフォルダ信頼確認">
      <p class="hwc-confirmation-eyebrow">
        <StatusMark tone="attention" size={14} />
        確認が必要です
      </p>
      <h2 class="hwc-confirmation-title" ref={heading} tabIndex={-1}>
        このフォルダを信頼して続行しますか？
      </h2>
      <p class="hwc-confirmation-path">{props.confirmation.directory}</p>
      <p class="hwc-confirmation-text">
        Codex は権限設定の範囲で、このフォルダのファイルを読み取り・編集・実行できます。
        フォルダ内の設定や hooks は、モデルへの依頼がなくてもコードを自動実行する場合があります。
        信頼できるファイルであることを確認してください。この判断は Codex に保存されます。
      </p>
      <div class="hwc-confirmation-actions">
        <button
          type="button"
          class="hwc-dialog-button hwc-dialog-primary"
          disabled={attempt !== "idle" || props.confirmation.submitted}
          onClick={() => void accept()}
        >
          {attempt === "sending" ? <Spinner /> : null}
          信頼して続行
        </button>
        <button type="button" class="hwc-dialog-button hwc-dialog-cancel" onClick={props.onDismiss}>
          ターミナルで操作
        </button>
      </div>
      {attempt === "failed" ? (
        <p class="hwc-confirmation-text" role="status">
          回答結果を確認できません。再送せず、ターミナルで確認してください。
        </p>
      ) : attempt === "sending" || waiting ? (
        <p class="hwc-confirmation-text" role="status">
          {attempt === "sending" ? "回答を送信しています…" : "確認画面が閉じるのを待っています…"}
        </p>
      ) : null}
      <p class="hwc-confirmation-note">
        {attempt === "idle" && !props.confirmation.submitted
          ? "「ターミナルで操作」は回答を保留します。拒否・キャンセルのキーは送りません。"
          : "ターミナルへ切り替えても、送信を始めた回答は取り消しません。"}
      </p>
    </section>
  );
}
