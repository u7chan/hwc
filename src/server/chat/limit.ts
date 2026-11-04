import type { ChatMessage } from "./contract";

// 直近の会話だけを返す。古い側は端末出力で読める。
export const MAX_CHAT_MESSAGES = 500;
export const MAX_CHAT_BYTES = 1024 * 1024;

export function limitMessages(messages: readonly ChatMessage[]): {
  messages: ChatMessage[];
  truncated: boolean;
} {
  const kept: ChatMessage[] = [];
  let bytes = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const size = Buffer.byteLength(message.text, "utf8");
    // 1 件で上限を超える場合は、その 1 件だけを返す。
    if (kept.length > 0 && (kept.length >= MAX_CHAT_MESSAGES || bytes + size > MAX_CHAT_BYTES)) {
      return { messages: kept.reverse(), truncated: true };
    }
    kept.push(message);
    bytes += size;
  }

  return { messages: kept.reverse(), truncated: false };
}
