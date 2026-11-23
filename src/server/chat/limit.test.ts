import { expect, test } from "bun:test";
import type { ChatMessage } from "./contract";
import { limitMessages, MAX_CHAT_BYTES } from "./limit";

test("ask_user option labels count toward the chat byte budget", () => {
  // 本文は上限未満だが、選択肢を足すと超える。古い行を落として truncated を返す。
  const newest: ChatMessage = {
    id: "new",
    role: "agent",
    text: "x".repeat(MAX_CHAT_BYTES - 10),
    at: 2,
    askOptions: [{ label: "y".repeat(20), recommended: true, selected: false }],
  };
  const older: ChatMessage = { id: "old", role: "user", text: "old", at: 1 };

  expect(limitMessages([older, newest])).toEqual({ messages: [newest], truncated: true });
});
