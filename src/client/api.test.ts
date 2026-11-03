import { expect, test } from "bun:test";
import {
  OUTPUT_LINES,
  attachmentUploadUrl,
  attachmentUrl,
  chatOutcome,
  chatUrl,
  closeOutcome,
  closeRequest,
  focusRequest,
  outputUrl,
  parseAppState,
  toAppState,
  toChatSnapshot,
  toPaneRead,
} from "./api";

const state = {
  focusedWorkspaceId: null,
  focusedTabId: null,
  focusedPaneId: null,
  workspaces: [],
};

test("the output request asks for the recent lines of the pane", () => {
  const url = new URL(outputUrl("w1:p2"), "http://localhost");

  // ":" is escaped but the BFF decodes it back into the pane id.
  expect(url.pathname).toBe("/api/panes/w1%3Ap2/output");
  expect(url.searchParams.get("source")).toBe("recent");
  expect(url.searchParams.get("lines")).toBe(String(OUTPUT_LINES));
});

test("the pane id is escaped so it stays a single path segment", () => {
  expect(outputUrl("w1/p2")).toContain("/api/panes/w1%2Fp2/output");
});

test("a state body needs a workspaces array", () => {
  expect(toAppState(state)).toEqual(state);
  expect(toAppState({ workspaces: "w1" })).toBeNull();
  expect(toAppState(null)).toBeNull();
});

test("a broken event body is dropped instead of thrown", () => {
  expect(parseAppState(JSON.stringify(state))).toEqual(state);
  expect(parseAppState("{")).toBeNull();
  expect(parseAppState('"state"')).toBeNull();
});

test("an output body is accepted only for the pane that was requested", () => {
  const body = { paneId: "w1:p2", text: "hi", truncated: false, revision: 3 };

  expect(toPaneRead(body, "w1:p2")).toEqual(body);
  expect(toPaneRead(body, "w1:p3")).toBeNull();
  expect(toPaneRead({ ...body, revision: "3" }, "w1:p2")).toBeNull();
  expect(toPaneRead({ ...body, truncated: null }, "w1:p2")).toBeNull();
  expect(toPaneRead({ ...body, text: 1 }, "w1:p2")).toBeNull();
});

test("empty output is still valid output", () => {
  expect(toPaneRead({ paneId: "p", text: "", truncated: true, revision: 0 }, "p")).toEqual({
    paneId: "p",
    text: "",
    truncated: true,
    revision: 0,
  });
});

test("the chat request names the pane and carries nothing else", () => {
  const url = new URL(chatUrl("w1:p2"), "http://localhost");

  expect(url.pathname).toBe("/api/panes/w1%3Ap2/chat");
  expect(url.search).toBe("");
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

const chatBody = {
  etag: "abc",
  messages: [{ id: "m1", role: "agent" as const, text: "hi", at: 1_000 }],
  model: "pi-large",
  effort: null,
  truncated: false,
  context: null,
  compaction: null,
};

test("a chat body is accepted as the contract describes it", () => {
  expect(toChatSnapshot(chatBody)).toEqual(chatBody);
  expect(toChatSnapshot({ ...chatBody, messages: [] })).toEqual({ ...chatBody, messages: [] });
  expect(toChatSnapshot({ ...chatBody, model: null })).toEqual({ ...chatBody, model: null });
});

test("a context that breaks the contract costs the numbers, not the conversation", () => {
  const wide = { tokens: 122_600, window: 1_000_000 };

  expect(toChatSnapshot({ ...chatBody, context: wide })).toEqual({ ...chatBody, context: wide });
  // 片方だけ分かる状態も契約のうち。
  expect(toChatSnapshot({ ...chatBody, context: { tokens: null, window: 1_000_000 } })).toEqual({
    ...chatBody,
    context: { tokens: null, window: 1_000_000 },
  });
  expect(toChatSnapshot({ ...chatBody, context: { tokens: 122_600, window: null } })).toEqual({
    ...chatBody,
    context: { tokens: 122_600, window: null },
  });
  // 形が違う context は数字を出さないだけにする。会話は捨てない。
  for (const context of [
    undefined,
    {},
    { tokens: "122600", window: 1_000_000 },
    { tokens: 122_600 },
    { tokens: 122_600, window: "1000000" },
    [122_600, 1_000_000],
    122_600,
  ]) {
    expect(toChatSnapshot({ ...chatBody, context })).toEqual({ ...chatBody, context: null });
  }
});

test("a compaction that breaks the contract costs the summary, not the conversation", () => {
  const compaction = { at: 1_700_000_000_000, tokensBefore: 212_959, summary: "so far" };

  expect(toChatSnapshot({ ...chatBody, compaction })).toEqual({ ...chatBody, compaction });
  // 形が違う compaction は要約を出さないだけにする。会話は捨てない。
  for (const broken of [
    undefined,
    {},
    { at: 1, summary: "so far" },
    { at: 1, tokensBefore: "212959", summary: "so far" },
    { at: 1, tokensBefore: null },
    "so far",
  ]) {
    expect(toChatSnapshot({ ...chatBody, compaction: broken })).toEqual({
      ...chatBody,
      compaction: null,
    });
  }
});

test("a chat body that breaks the contract is dropped", () => {
  expect(toChatSnapshot(null)).toBeNull();
  expect(toChatSnapshot({ ...chatBody, etag: undefined })).toBeNull();
  expect(toChatSnapshot({ ...chatBody, truncated: "no" })).toBeNull();
  // null と文字列以外は「無い」と区別できないので受けない。
  expect(toChatSnapshot({ ...chatBody, effort: undefined })).toBeNull();
  expect(toChatSnapshot({ ...chatBody, messages: null })).toBeNull();
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...chatBody.messages[0], role: "system" }] }),
  ).toBeNull();
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...chatBody.messages[0], at: "1" }] }),
  ).toBeNull();
});

test("the attachment urls keep the pane id and the saved name in single segments", () => {
  const upload = new URL(attachmentUploadUrl("w1:p2"), "http://localhost");
  expect(upload.pathname).toBe("/api/panes/w1%3Ap2/attachments");

  expect(attachmentUrl("w1:p2", "pasted-20261103-120000.png")).toBe(
    "/api/panes/w1%3Ap2/attachments/pasted-20261103-120000.png",
  );
  // 名前に区切りが入っても 1 セグメントのまま送る。
  expect(new URL(attachmentUrl("w1:p2", "../x.png"), "http://localhost").pathname).toBe(
    "/api/panes/w1%3Ap2/attachments/..%2Fx.png",
  );
});

test("a message keeps its attachments only as names in the saved format", () => {
  const message = {
    id: "m1",
    role: "user" as const,
    text: "",
    at: 1_000,
    attachments: ["pasted-20261103-120000.png", "pasted-20261103-120000-1.jpg"],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([message]);

  // 書式の外れた名前は配信 URL にしない。名前が全部落ちたら添付なしとして扱う。
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...message, attachments: ["../x.png"] }] })
      ?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, attachments: "pasted-20261103-120000.png" }],
    })?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...message, attachments: [] }] })?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
});

test("the focus request posts to the pane with a JSON header and no body", () => {
  const request = focusRequest("w1:p2");
  const url = new URL(request.url, "http://localhost");

  // ":" is escaped but the BFF decodes it back into the pane id.
  expect(url.pathname).toBe("/api/panes/w1%3Ap2/focus");
  expect(request.init.method).toBe("POST");
  // ヘッダを落とすと BFF が 415 で弾く。body は読まれないので送らない。
  expect(request.init.headers).toEqual({ "content-type": "application/json" });
  expect(request.init.body).toBeUndefined();
});

test("the focus request keeps the pane id in a single path segment", () => {
  expect(focusRequest("w1/p2").url).toBe("/api/panes/w1%2Fp2/focus");
});

test("the close request posts to the pane with a JSON header and no body", () => {
  const request = closeRequest("w1:p2");
  const url = new URL(request.url, "http://localhost");

  expect(url.pathname).toBe("/api/panes/w1%3Ap2/close");
  expect(request.init.method).toBe("POST");
  // ヘッダを落とすと BFF が 415 で弾く。body は読まれないので送らない。
  expect(request.init.headers).toEqual({ "content-type": "application/json" });
  expect(request.init.body).toBeUndefined();
  expect(closeRequest("w1/p2").url).toBe("/api/panes/w1%2Fp2/close");
});

test("close is done once the pane is gone, whatever removed it", () => {
  // 404 は「BFF の状態に無い」と「Herdr が pane_not_found」のどちらでも、閉じる目的は達している。
  expect(closeOutcome(404)).toBe("done");
  expect(closeOutcome(200)).toBe("done");
});

test("close fails on any other status", () => {
  expect(closeOutcome(400)).toBe("failed");
  expect(closeOutcome(415)).toBe("failed");
  expect(closeOutcome(502)).toBe("failed");
});
