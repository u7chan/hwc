import type { ChatMessage } from "./contract";

// 直近の会話だけを返す。古い側は端末出力で読める。
export const MAX_CHAT_MESSAGES = 500;
export const MAX_CHAT_BYTES = 1024 * 1024;

// 本文だけでなく、合成質問の選択肢も応答のバイト数に含める。
function chatMessageBytes(message: ChatMessage): number {
  let size = Buffer.byteLength(message.text, "utf8");
  for (const option of message.askOptions ?? []) {
    size += Buffer.byteLength(option.label, "utf8");
  }
  return size;
}

export function limitMessages(messages: readonly ChatMessage[]): {
  messages: ChatMessage[];
  truncated: boolean;
} {
  const kept: ChatMessage[] = [];
  let bytes = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const size = chatMessageBytes(message);
    // 1 件で上限を超える場合は、その 1 件だけを返す。
    if (kept.length > 0 && (kept.length >= MAX_CHAT_MESSAGES || bytes + size > MAX_CHAT_BYTES)) {
      return { messages: kept.reverse(), truncated: true };
    }
    kept.push(message);
    bytes += size;
  }

  return { messages: kept.reverse(), truncated: false };
}

// 古い側の切り捨てで質問だけが落ちたとき、対応する回答を単独で残さない。
export function pruneOrphanAskAnswers(messages: readonly ChatMessage[]): ChatMessage[] {
  const ids = new Set(messages.map((message) => message.id));
  return messages.filter((message) => {
    if (message.synthetic !== true || message.role !== "user") return true;
    const match = /^ask:(.+):answer$/.exec(message.id);
    return match === null || ids.has(`ask:${match[1]}:question`);
  });
}
