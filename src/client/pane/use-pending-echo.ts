import { useEffect, useState } from "preact/hooks";
import type { ChatMessage, ChatSnapshot } from "../../server/chat/contract";
import type { PendingMessage } from "../chat";
import {
  nextPendingDeadline,
  reducePending,
  type PendingEchoInput,
  type PendingOperation,
} from "./pending-echo";

const NO_MESSAGES: ChatMessage[] = [];

export type PendingEchoSource = {
  snapshot: ChatSnapshot | null;
  replying: boolean;
};

export type PendingEchoHandle = {
  echoes: PendingMessage[];
  add: (echo: PendingEchoInput) => void;
  failAnswer: (toolUseId: string, at: number) => void;
  reset: () => void;
};

// 遷移は pending-echo の reducer が持つ。ここはスナップショットと操作で 1 回進めることと、
// 次に切れる時刻までのタイマー 1 本だけを持つ。
export function usePendingEcho(source: PendingEchoSource): PendingEchoHandle {
  const [echoes, setEchoes] = useState<PendingMessage[]>([]);
  const messages = source.snapshot?.messages ?? NO_MESSAGES;
  const activeToolUseId = source.snapshot?.pending?.toolUseId;
  const replying = source.replying;

  const update = (operation: PendingOperation) => {
    setEchoes((items) =>
      reducePending(items, { messages, activeToolUseId, replying, now: Date.now(), operation }),
    );
  };

  useEffect(() => {
    const now = Date.now();
    const settled = reducePending(echoes, { messages, activeToolUseId, replying, now });
    if (settled !== echoes) {
      setEchoes(settled);
      return;
    }
    const deadline = nextPendingDeadline(settled, replying);
    if (deadline === null) return;
    const timer = window.setTimeout(
      () =>
        setEchoes((items) =>
          reducePending(items, { messages, activeToolUseId, replying, now: Date.now() }),
        ),
      Math.max(0, deadline - now),
    );
    return () => window.clearTimeout(timer);
  }, [echoes, messages, activeToolUseId, replying]);

  return {
    echoes,
    add: (echo) => update({ kind: "echo", echo }),
    failAnswer: (toolUseId, at) => update({ kind: "answerFailed", toolUseId, at }),
    reset: () => update({ kind: "reset" }),
  };
}
