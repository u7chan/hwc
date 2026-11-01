import { expect, test } from "bun:test";
import { appendMessage, mockReply, type ChatMessage } from "./chat";

const message = (id: string): ChatMessage => ({ id, role: "user", text: "hi", at: 0 });

test("appending a message keeps the earlier ones in order", () => {
  const first = appendMessage([], message("m1"));
  const second = appendMessage(first, message("m2"));

  expect(second.map((item) => item.id)).toEqual(["m1", "m2"]);
  expect(first.map((item) => item.id)).toEqual(["m1"]);
});

test("the preview reply quotes the first line of the message", () => {
  const reply = mockReply("一覧の並びを直したい\n詳細はこちら", 0);

  expect(reply).toContain("一覧の並びを直したい");
  expect(reply.length).toBeGreaterThan(20);
});

test("consecutive preview replies differ", () => {
  expect(mockReply("a", 0)).not.toBe(mockReply("a", 1));
});
