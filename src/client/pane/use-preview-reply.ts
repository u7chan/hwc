import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage } from "../../server/chat/contract";

// 最後のエージェント側のメッセージ時刻。自分の送信ではバッジを出さない。
function latestReplyAt(messages: readonly ChatMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role !== "user") return message.at;
  }
  return null;
}

// プレビュー中に届いた返答を、会話に戻るボタンのバッジで知らせる。
export function usePreviewReplyBadge(
  open: boolean,
  messages: readonly ChatMessage[] | null,
): boolean {
  const [hasNewReply, setHasNewReply] = useState(false);
  const baseline = useRef<number | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!open) {
      initialized.current = false;
      baseline.current = null;
      setHasNewReply(false);
      return;
    }
    // チャットの取得が終わる前に開いた場合、最初に届いた表示を基準にする。
    // 既存の会話を新着として扱わないため。
    if (messages === null) return;
    const latest = latestReplyAt(messages);
    if (!initialized.current) {
      initialized.current = true;
      baseline.current = latest;
      return;
    }
    if (latest !== null && (baseline.current === null || latest > baseline.current)) {
      setHasNewReply(true);
    }
  }, [open, messages]);

  return hasNewReply;
}
