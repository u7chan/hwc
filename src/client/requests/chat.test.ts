import { expect, test } from "bun:test";
import { createApiClient, paneParam } from "../api";
import { chatOutcome, parseActivitySession } from "./chat";

const api = createApiClient("http://localhost");

test("the chat request names the pane and carries nothing else", () => {
  expect(api.api.panes[":id"].chat.$url(paneParam("w1:p2")).pathname).toBe(
    "/api/panes/w1%3Ap2/chat",
  );
});

test("a 304 keeps the messages already in hand", () => {
  expect(chatOutcome(304)).toBe("unchanged");
  expect(chatOutcome(200)).toBe("snapshot");
});

test("a pane without a session or without herdr falls back to the output", () => {
  expect(chatOutcome(404)).toBe("unavailable");
  expect(chatOutcome(502)).toBe("unavailable");
  expect(chatOutcome(500)).toBe("unavailable");
});

test("an activity session is kept only as a comparable id", () => {
  expect(parseActivitySession("sess-1")).toBe("sess-1");
  // 前回の値と比べるだけの id。空文字と制御文字は、比べる値にならないので捨てる。
  for (const value of ["", "sess\n1", "sess\t1", 3, null]) {
    expect(parseActivitySession(value)).toBeNull();
  }
});
