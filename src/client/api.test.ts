import { expect, expectTypeOf, test } from "bun:test";
import type { ClientResponse } from "hono/client";
import {
  OUTPUT_LINES,
  attachmentUploadUrl,
  agentModelsOutcome,
  attachmentUrl,
  chatFileUrl,
  chatOutcome,
  closeOutcome,
  createApiClient,
  inputRequest,
  outputRequest,
  paneParam,
  parseAppState,
  previewUrl,
  toAppState,
  toChatSnapshot,
  CREATE_TIMEOUT_MS,
  toCreateError,
  toCreatedPane,
  toPaneRead,
  toAgentModels,
  toAgentEfforts,
  MODEL_CREATE_TIMEOUT_MS,
  MODEL_CREATE_WORKTREE_TIMEOUT_MS,
  CREATE_WORKTREE_TIMEOUT_MS,
  canRetryWorktree,
  toCreatedWorktree,
  toWorktreeError,
  toPaneInteraction,
} from "./api";

const api = createApiClient("http://localhost");

test("model candidates keep only their provider and id", () => {
  expect(
    toAgentModels({ models: [{ provider: "example", id: "beam", secret: "hidden" }] }),
  ).toEqual([{ provider: "example", id: "beam" }]);
  expect(toAgentModels({ models: [] })).toEqual([]);
  for (const body of [
    null,
    {},
    { models: "beam" },
    { models: [{ id: "beam" }] },
    { models: [{ provider: "example", id: "--help" }] },
  ]) {
    expect(toAgentModels(body)).toBeNull();
  }
});

test("model candidates with namespaced @ IDs remain selectable", () => {
  const model = { provider: "cloudflare-workers-ai", id: "@cf/meta/llama-3.2-3b-instruct" };
  expect(toAgentModels({ models: [model] })).toEqual([model]);
});

test("model lookup distinguishes an unstarted OpenCode service from generic failures", () => {
  expect(agentModelsOutcome(502, { error: "opencode_not_running" })).toBe("opencode_not_running");
  expect(agentModelsOutcome(502, { error: "models_unavailable" })).toBeNull();
  expect(agentModelsOutcome(502, { error: "/private/path: credentials" })).toBeNull();
  expect(agentModelsOutcome(502, null)).toBeNull();
  expect(agentModelsOutcome(200, { error: "opencode_not_running" })).toBeNull();
  expect(agentModelsOutcome(403, { error: "opencode_not_running" })).toBeNull();
  expect(agentModelsOutcome(200, { models: [] })).toEqual([]);
  const models = [{ provider: "example", id: "beam" }];
  expect(agentModelsOutcome(200, { models })).toEqual(models);
  expect(agentModelsOutcome(502, { models })).toBeNull();
});

test("model-specific creation also covers candidate lookup and session preparation", () => {
  expect(MODEL_CREATE_TIMEOUT_MS).toBeGreaterThan(CREATE_TIMEOUT_MS + 53_000);
});

test("effort choices preserve native names and order rather than translating them to a common scale", () => {
  expect(toAgentEfforts({ efforts: ["none", "xhigh", "max", "じっくり review", "xhigh"] })).toEqual(
    ["none", "xhigh", "max", "じっくり review"],
  );
  expect(toAgentEfforts({ efforts: [] })).toEqual([]);
  for (const body of [
    null,
    {},
    { efforts: "high" },
    { efforts: [null] },
    { efforts: [""] },
    { efforts: ["a\nb"] },
  ]) {
    expect(toAgentEfforts(body)).toBeNull();
  }
});

test("the effort request keeps the pane id and namespaced model in their own URL parts", () => {
  const url = api.api.panes[":id"].efforts.$url({
    ...paneParam("w1/p2"),
    query: { agent: "pi", provider: "example", model: "@demo/beam" },
  });
  expect(url.pathname).toBe("/api/panes/w1%2Fp2/efforts");
  expect(url.searchParams.get("model")).toBe("@demo/beam");
});

test("the JSON pane routes expose their media type rejection through RPC", () => {
  type PaneRoutes = (typeof api.api.panes)[":id"];
  type JsonAction =
    | "input"
    | "stop"
    | "clear-output"
    | "focus"
    | "close"
    | "exit"
    | "split"
    | "confirm-folder-trust";
  type Rejections = {
    [Action in JsonAction]: Extract<
      Awaited<ReturnType<PaneRoutes[Action]["$post"]>>,
      { status: 415 }
    >;
  };
  type Rejection = ClientResponse<{ error: string }, 415, "json">;

  expectTypeOf<Rejections>().toEqualTypeOf<Record<JsonAction, Rejection>>();
});

const state = {
  focusedWorkspaceId: null,
  focusedTabId: null,
  focusedPaneId: null,
  times: { workingSince: {}, finishedAt: {} },
  workspaces: [],
};

test("the output request asks for the recent lines of the pane", () => {
  const url = api.api.panes[":id"].output.$url(outputRequest("w1:p2"));

  expect(url.pathname).toBe("/api/panes/w1%3Ap2/output");
  expect(url.searchParams.get("source")).toBe("recent");
  expect(url.searchParams.get("lines")).toBe(String(OUTPUT_LINES));
});

test("the request builders keep the pane id in a single path segment", () => {
  expect(paneParam("w1/p2")).toEqual({ param: { id: "w1%2Fp2" } });
  // どのルートも paneParam を 1 度だけ通す。id に / や : が入っても経路は増えない。
  const paneRoutes = (action: string) => `/api/panes/w1%2Fp2/${action}`;
  expect(api.api.panes[":id"].output.$url(outputRequest("w1/p2")).pathname).toBe(
    paneRoutes("output"),
  );
  expect(api.api.panes[":id"].input.$url(inputRequest("w1/p2", "hi")).pathname).toBe(
    paneRoutes("input"),
  );
  expect(api.api.panes[":id"].focus.$url(paneParam("w1/p2")).pathname).toBe(paneRoutes("focus"));
  expect(api.api.panes[":id"].stop.$url(paneParam("w1/p2")).pathname).toBe(paneRoutes("stop"));
  expect(api.api.panes[":id"]["clear-output"].$url(paneParam("w1/p2")).pathname).toBe(
    paneRoutes("clear-output"),
  );
  expect(api.api.panes[":id"].close.$url(paneParam("w1/p2")).pathname).toBe(paneRoutes("close"));
  expect(api.api.panes[":id"].split.$url(paneParam("w1/p2")).pathname).toBe(paneRoutes("split"));
});

test("the input request keeps the pane id and JSON body together", () => {
  expect(inputRequest("w1:p2", "hi")).toEqual({
    param: { id: "w1%3Ap2" },
    json: { text: "hi", submit: true },
  });
  expect(inputRequest("w1:p2", "hi", ["a.png"])).toEqual({
    param: { id: "w1%3Ap2" },
    json: { text: "hi", submit: true, attachments: ["a.png"] },
  });
});

test("a state body needs a workspaces array", () => {
  expect(toAppState(state)).toEqual(state);
  expect(toAppState({ workspaces: "w1" })).toBeNull();
  expect(toAppState(null)).toBeNull();
});

test("a message carries the state and the server clock it was sent with", () => {
  expect(parseAppState(JSON.stringify({ state, now: 1_000 }))).toEqual({ state, now: 1_000 });
  // 読めない now でも状態は適用し、時計だけ据え置く。
  expect(parseAppState(JSON.stringify({ state }))).toEqual({ state, now: null });
  expect(parseAppState(JSON.stringify({ state, now: "1000" }))).toEqual({ state, now: null });
});

test("a broken event body is dropped instead of thrown", () => {
  expect(parseAppState("{")).toBeNull();
  expect(parseAppState('"state"')).toBeNull();
  expect(parseAppState(JSON.stringify(state))).toBeNull();
  expect(parseAppState(JSON.stringify({ now: 1_000 }))).toBeNull();
});

test("an output body is accepted only for the pane that was requested", () => {
  const body = { paneId: "w1:p2", text: "hi", truncated: false, revision: 3, interaction: null };

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
    interaction: null,
  });
});

test("confirmation snapshots validate their identity, scope and submitted state", () => {
  const confirmation = {
    kind: "folder-trust" as const,
    id: "prompt-1",
    agent: "codex" as const,
    directory: "/workspace/demo",
    submitted: false,
  };
  expect(toPaneInteraction(confirmation)).toEqual(confirmation);
  expect(toPaneInteraction({ ...confirmation, agent: "pi" })).toEqual({
    ...confirmation,
    agent: "pi",
  });
  expect(toPaneInteraction(null)).toBeNull();
  for (const value of [
    { kind: "unknown" },
    { ...confirmation, agent: "claude" },
    { ...confirmation, id: null },
    { ...confirmation, submitted: "false" },
  ]) {
    expect(toPaneInteraction(value)).toEqual({ kind: "terminal" });
  }
});

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

test("a failed turn is read as an error row", () => {
  const message = { id: "e1", role: "error" as const, text: "429: busy", at: 1_000 };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })).toEqual({
    ...chatBody,
    messages: [message],
  });
});

test("a retry count is kept only when it is a real count", () => {
  const error = { id: "e1", role: "error" as const, text: "429: busy", at: 1_000 };
  expect(toChatSnapshot({ ...chatBody, messages: [{ ...error, count: 4 }] })?.messages).toEqual([
    { ...error, count: 4 },
  ]);
  // 1 回だけの失敗は count を持たない。壊れた値は回数を出さないだけで、行は残す。
  for (const count of [1, 0, -2, 1.5, "4", null]) {
    expect(toChatSnapshot({ ...chatBody, messages: [{ ...error, count }] })?.messages).toEqual([
      error,
    ]);
  }
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

test("usage parts survive validation without sacrificing the conversation when malformed", () => {
  const usage = { input: 81_000, output: 900, cacheRead: 0, cacheWrite: null, reasoning: null };
  expect(toChatSnapshot({ ...chatBody, usage })).toEqual({ ...chatBody, usage });
  for (const broken of [
    { ...usage, input: -1 },
    { ...usage, output: "900" },
    { ...usage, cacheRead: NaN },
    {},
  ]) {
    expect(toChatSnapshot({ ...chatBody, usage: broken })).toEqual(chatBody);
  }
});

test("a compaction that breaks the contract costs the summary, not the conversation", () => {
  const compaction = { at: 1_700_000_000_000, tokensBefore: 212_959, summary: "so far", index: 0 };

  expect(toChatSnapshot({ ...chatBody, compaction })).toEqual({ ...chatBody, compaction });
  // 形が違う compaction は要約を出さないだけにする。会話は捨てない。
  for (const broken of [
    undefined,
    {},
    { at: 1, summary: "so far" },
    { at: 1, tokensBefore: "212959", summary: "so far" },
    { at: 1, tokensBefore: null },
    { at: 1, tokensBefore: null, summary: "so far" },
    { at: 1, tokensBefore: null, summary: "so far", index: -1 },
    { at: 1, tokensBefore: null, summary: "so far", index: 1.5 },
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

test("a message keeps its attachments as saved names and sizes, images or not", () => {
  const message = {
    id: "m1",
    role: "user" as const,
    text: "",
    at: 1_000,
    attachments: [
      { name: "pasted-20261103-120000.png", size: 2048 },
      { name: "report.zip", size: 3_013_590 },
      { name: "My Report.xlsx", size: null },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([message]);

  // サイズは表示だけに使う。壊れた値は名前だけを出す。
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, attachments: [{ name: "report.zip", size: "big" }] }],
    })?.messages,
  ).toEqual([
    {
      id: "m1",
      role: "user",
      text: "",
      at: 1_000,
      attachments: [{ name: "report.zip", size: null }],
    },
  ]);

  // 負数・小数・非数は表示に使わない。名前だけを残す。
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [
        {
          ...message,
          attachments: [
            { name: "report.zip", size: -1 },
            { name: "report-1.zip", size: 1.9 },
            { name: "report-2.zip", size: Number.NaN },
          ],
        },
      ],
    })?.messages,
  ).toEqual([
    {
      id: "m1",
      role: "user",
      text: "",
      at: 1_000,
      attachments: [
        { name: "report.zip", size: null },
        { name: "report-1.zip", size: 1 },
        { name: "report-2.zip", size: null },
      ],
    },
  ]);

  // 保存名の規則を通らない名前は配信 URL にしない。名前が全部落ちたら添付なしとして扱う。
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, attachments: [{ name: "../x.png", size: 1 }] }],
    })?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, attachments: [{ name: ".env", size: 1 }] }],
    })?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...message, attachments: [] }] })?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
});

test("a preview url keeps the root and the path separators", () => {
  expect(
    previewUrl("w1:p2", {
      name: "docs/モック.html",
      version: "1-2",
      kind: "html",
      root: 1,
    }),
  ).toBe(`/api/panes/w1%3Ap2/preview/1/docs/${encodeURIComponent("モック.html")}`);
  // 区切りは残す。相対参照がそのまま効く。
  expect(
    previewUrl("w1:p1", { name: "preview/index.html", version: "1-2", kind: "html", root: 0 }),
  ).toBe("/api/panes/w1%3Ap1/preview/0/preview/index.html");
});

test("a file keeps the root label only as a display string", () => {
  const snapshotWithLabel = (rootLabel: unknown) =>
    toChatSnapshot({
      ...chatBody,
      messages: [
        {
          id: "m1",
          role: "agent" as const,
          text: "`docs/mock.html`",
          at: 1_000,
          files: [{ name: "docs/mock.html", version: "1-2", kind: "html", root: 1, rootLabel }],
        },
      ],
    })?.messages[0]?.files?.[0];

  // チェックアウト以外の根は、固定の表記か設定値の basename だけを持つ。
  expect(snapshotWithLabel("/tmp")?.rootLabel).toBe("/tmp");
  expect(snapshotWithLabel("mock")?.rootLabel).toBe("mock");
  // 長い basename は描画側で抑える。黙って捨てない。
  const long = "a".repeat(120);
  expect(snapshotWithLabel(long)?.rootLabel).toBe(long);

  // 絶対パスを渡さない契約なので、区切りを含む値は捨てる。
  for (const broken of ["/srv/mock", "a/b", "a\\b", "", 3, null]) {
    expect(snapshotWithLabel(broken)?.rootLabel).toBeUndefined();
  }
});

test("an image url carries the root, relative path and version", () => {
  expect(
    chatFileUrl("w1:p2", {
      name: "docs/モック.png",
      version: "1767225600000-12",
      kind: "image",
      root: 0,
    }),
  ).toBe(
    `/api/panes/w1%3Ap2/files?root=0&path=${encodeURIComponent("docs/モック.png")}&v=1767225600000-12`,
  );
  // 追加根の画像も同じ URL の形で、根の番号だけが変わる。
  expect(chatFileUrl("w1:p1", { name: "mock.png", version: "1-2", kind: "image", root: 1 })).toBe(
    "/api/panes/w1%3Ap1/files?root=1&path=mock.png&v=1-2",
  );
  // 区切りの入った名前も、クエリの 1 値として送る。
  expect(chatFileUrl("w1:p1", { name: "../x.png", version: "1-2", kind: "image", root: 0 })).toBe(
    "/api/panes/w1%3Ap1/files?root=0&path=..%2Fx.png&v=1-2",
  );
});

test("an image keeps only the inline refs the client can draw", () => {
  const message = {
    id: "m1",
    role: "agent" as const,
    text: "![モック](docs/mock.png)",
    at: 1_000,
    files: [
      {
        name: "docs/mock.png",
        version: "1-2",
        kind: "image" as const,
        root: 0,
        imageRefs: ["docs/mock.png", "docs/other.png", 3, "", null],
      },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([
    {
      ...message,
      files: [
        {
          name: "docs/mock.png",
          version: "1-2",
          kind: "image",
          root: 0,
          imageRefs: ["docs/mock.png", "docs/other.png"],
        },
      ],
    },
  ]);

  // 使える表記が 1 つも無ければ持たない。末尾の一覧に戻る。
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, files: [{ ...message.files[0], imageRefs: [""] }] }],
    })?.messages[0]?.files,
  ).toEqual([{ name: "docs/mock.png", version: "1-2", kind: "image", root: 0 }]);
});

test("an agent message keeps the files the server found", () => {
  const message = {
    id: "m1",
    role: "agent" as const,
    text: "`docs/mock.png` に置きました。",
    at: 1_000,
    files: [
      {
        name: "docs/mock.png",
        version: "1767225600000-12",
        kind: "image" as const,
        root: 0,
        imageRefs: ["docs/mock.png"],
      },
      {
        name: "docs/preview/index.html",
        version: "1767225600000-20",
        kind: "html" as const,
        root: 0,
      },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([message]);

  // 配信 URL になる。根の外を指す名前や壊れた版・根の番号、知らない見せ方は捨てる。
  const broken = {
    ...message,
    files: [
      { name: "/etc/passwd.png", version: "1-2", kind: "image", root: 0 },
      { name: "../secret.png", version: "1-2", kind: "image", root: 0 },
      { name: "", version: "1-2", kind: "image", root: 0 },
      { name: "docs/ok.png", version: 3, kind: "image", root: 0 },
      { name: "docs/neg.png", version: "1-2", kind: "image", root: -1 },
      { name: "docs/frac.png", version: "1-2", kind: "image", root: 1.5 },
      { name: "docs/none.png", version: "1-2", kind: "image" },
      { name: "docs/note.md", version: "1-2", kind: "markdown", root: 0 },
      { name: "docs/note.md", version: "1-2" },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [broken] })?.messages).toEqual([
    { id: "m1", role: "agent", text: message.text, at: 1_000 },
  ]);
  expect(toChatSnapshot({ ...chatBody, messages: [{ ...message, files: [] }] })?.messages).toEqual([
    { id: "m1", role: "agent", text: message.text, at: 1_000 },
  ]);
});

test("an agent message keeps the name of a file outside the roots", () => {
  const message = {
    id: "m1",
    role: "agent" as const,
    text: "モックは `/tmp/demo/mock.html` に置きました。",
    at: 1_000,
    outsideFile: "mock.html",
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([message]);

  // 名前だけを描く。パスや空文字は、契約違反として捨てる。
  for (const outsideFile of ["/tmp/demo/mock.html", "docs/mock.html", "", 3, null]) {
    expect(
      toChatSnapshot({ ...chatBody, messages: [{ ...message, outsideFile }] })?.messages[0],
    ).toEqual({ id: "m1", role: "agent", text: message.text, at: 1_000 });
  }
});

test("the created pane id is read from the response", () => {
  expect(toCreatedPane({ paneId: "w1:p2" })).toBe("w1:p2");
  expect(toCreatedPane({ paneId: "" })).toBeNull();
  expect(toCreatedPane({ paneId: 2 })).toBeNull();
  expect(toCreatedPane(null)).toBeNull();
});

test("close is done once the pane is gone, whatever removed it", () => {
  // 404 は「BFF の状態に無い」と「Herdr が pane_not_found」のどちらでも、閉じる目的は達している。
  expect(closeOutcome(404)).toBe("done");
  expect(closeOutcome(200)).toBe("done");
});

test("close fails on any other status", () => {
  expect(closeOutcome(400)).toBe("failed");
  expect(closeOutcome(409)).toBe("failed");
  expect(closeOutcome(415)).toBe("failed");
  expect(closeOutcome(502)).toBe("failed");
});

test("a create error keeps the pane id only when the split already happened", () => {
  expect(toCreateError({ error: "agent_start_failed", paneId: "w1:p3" })).toEqual({
    error: "agent_start_failed",
    paneId: "w1:p3",
  });
  expect(toCreateError({ error: "pane_limit" })).toEqual({ error: "pane_limit", paneId: null });
  expect(toCreateError({ error: "pane_rename_failed", paneId: "w1:p3" })).toEqual({
    error: "pane_rename_failed",
    paneId: "w1:p3",
  });
  expect(toCreateError({ error: "something_else" })).toEqual({ error: "failed", paneId: null });
  expect(toCreateError(null)).toEqual({ error: "failed", paneId: null });
});

test("the create timeout leaves room for the agent start wait", () => {
  expect(CREATE_TIMEOUT_MS).toBeGreaterThan(59_000);
});

test("the created worktree ids are read from the response", () => {
  expect(toCreatedWorktree({ workspaceId: "w2", paneId: "w2:p1" })).toEqual({
    workspaceId: "w2",
    paneId: "w2:p1",
  });
  expect(toCreatedWorktree({ workspaceId: "w2" })).toBeNull();
  expect(toCreatedWorktree({ workspaceId: "", paneId: "w2:p1" })).toBeNull();
  expect(toCreatedWorktree({ workspaceId: "w2", paneId: 1 })).toBeNull();
  expect(toCreatedWorktree(null)).toBeNull();
});

test("a worktree error keeps the ids only when the checkout already exists", () => {
  expect(
    toWorktreeError({ error: "agent_start_failed", workspaceId: "w2", paneId: "w2:p1" }),
  ).toEqual({ error: "agent_start_failed", workspaceId: "w2", paneId: "w2:p1" });
  expect(toWorktreeError({ error: "worktree_open_failed" })).toEqual({
    error: "worktree_open_failed",
    workspaceId: null,
    paneId: null,
  });
  expect(toWorktreeError({ error: "herdr_unavailable" })).toEqual({
    error: "herdr_unavailable",
    workspaceId: null,
    paneId: null,
  });
  expect(toWorktreeError({ error: "pane_limit" })).toEqual({
    error: "failed",
    workspaceId: null,
    paneId: null,
  });
  expect(toWorktreeError(null)).toEqual({ error: "failed", workspaceId: null, paneId: null });
});

test("only an explicit creation failure or a busy checkout can be retried", () => {
  // Herdr が作成失敗を明示した場合と、同じチェックアウトへの同時操作だけ。
  expect(canRetryWorktree("worktree_create_failed")).toBe(true);
  expect(canRetryWorktree("worktree_operation_in_progress")).toBe(true);
  // 作成できたか確認できない失敗は、再送で 2 つ目のワークツリーを作りかねない。
  expect(canRetryWorktree("worktree_open_failed")).toBe(false);
  expect(canRetryWorktree("herdr_unavailable")).toBe(false);
  expect(canRetryWorktree("timeout")).toBe(false);
  expect(canRetryWorktree("failed")).toBe(false);
  // 起点を変える必要がある失敗は、同じ入力を送り直しても通らない。
  expect(canRetryWorktree("linked_worktree_source")).toBe(false);
  expect(canRetryWorktree("not_git_worktree")).toBe(false);
  expect(canRetryWorktree("workspace_not_found")).toBe(false);
});

test("the worktree timeout covers the creation and the agent start", () => {
  expect(CREATE_WORKTREE_TIMEOUT_MS).toBeGreaterThan(90_000);
  expect(MODEL_CREATE_WORKTREE_TIMEOUT_MS).toBeGreaterThan(CREATE_WORKTREE_TIMEOUT_MS + 50_000);
});
