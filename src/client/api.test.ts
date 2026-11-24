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
  CREATE_TIMEOUT_MS,
  toCreateError,
  toStartError,
  toCreatedPane,
  toPaneRead,
  toAgentModels,
  toModelLabels,
  toAgentEfforts,
  toModelInfo,
  MODEL_CREATE_TIMEOUT_MS,
  CREATE_WORKTREE_TIMEOUT_MS,
  canRetryWorktree,
  toCreatedSpace,
  toWorktreeError,
  toSpaceError,
  toPaneInteraction,
} from "./api";

const api = createApiClient("http://localhost");

const state = {
  focusedWorkspaceId: null,
  focusedTabId: null,
  focusedPaneId: null,
  times: { workingSince: {}, finishedAt: {} },
  workspaces: [],
};

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

test("model labels keep only usable display names", () => {
  expect(
    toModelLabels({ labels: { "claude/opus": "Opus 5.5", "claude/sonnet": "Sonnet 5.5" } }),
  ).toEqual({ "claude/opus": "Opus 5.5", "claude/sonnet": "Sonnet 5.5" });
  expect(toModelLabels({ labels: null })).toBeNull();
  expect(toModelLabels({ labels: {} })).toEqual({});
  for (const body of [null, {}, { labels: "Opus" }, { labels: [] }]) {
    expect(toModelLabels(body)).toBeNull();
  }
  expect(toModelLabels({ labels: { "": "Opus", "claude/opus": "", "claude/sonnet": 3 } })).toEqual(
    {},
  );
});

test("model candidates with namespaced @ IDs remain selectable", () => {
  const model = { provider: "cloudflare-workers-ai", id: "@cf/meta/llama-3.2-3b-instruct" };
  expect(toAgentModels({ models: [model] })).toEqual([model]);
});

test("the model info keeps only a model and a valid effort", () => {
  expect(toModelInfo({ model: "beam", effort: "high" })).toEqual({
    model: "beam",
    effort: "high",
  });
  expect(toModelInfo({ model: "beam" })).toEqual({ model: "beam", effort: null });
  expect(toModelInfo({ model: "beam", effort: null })).toEqual({ model: "beam", effort: null });
  for (const body of [
    null,
    {},
    { model: "" },
    { model: 1 },
    { model: "beam", effort: 3 },
    { model: "beam", effort: "high\nexit" },
  ]) {
    expect(toModelInfo(body)).toBeNull();
  }
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

test("a preview url keeps the root and the path separators", () => {
  expect(previewUrl("w1:p2", { name: "docs/モック.html", root: 1 })).toBe(
    `/api/panes/w1%3Ap2/preview/1/docs/${encodeURIComponent("モック.html")}`,
  );
  // 区切りは残す。相対参照がそのまま効く。
  expect(previewUrl("w1:p1", { name: "preview/index.html", root: 0 })).toBe(
    "/api/panes/w1%3Ap1/preview/0/preview/index.html",
  );
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
  // コードが文字列でなくても、id は読める。既知かどうかと id の有無は別の判断。
  expect(toCreateError({ error: 3, paneId: "w1:p3" })).toEqual({
    error: "failed",
    paneId: "w1:p3",
  });
  // ペインの作成では、応答に workspaceId が混ざっていても返さない。
  expect(toCreateError({ error: "pane_limit", workspaceId: "w1", paneId: "w1:p3" })).toEqual({
    error: "pane_limit",
    paneId: "w1:p3",
  });
});

test("a start error keeps only the codes the BFF can return", () => {
  expect(toStartError({ error: "pane_busy" })).toBe("pane_busy");
  expect(toStartError({ error: "agent_start_failed" })).toBe("agent_start_failed");
  // 起動の失敗と作成の失敗で、通す一覧は違う。
  expect(toStartError({ error: "pane_limit" })).toBe("failed");
  expect(toStartError({ error: 3 })).toBe("failed");
  expect(toStartError(null)).toBe("failed");
});

test("the create timeout leaves room for the agent start wait", () => {
  expect(CREATE_TIMEOUT_MS).toBeGreaterThan(59_000);
});

test("the created worktree ids are read from the response", () => {
  expect(toCreatedSpace({ workspaceId: "w2", paneId: "w2:p1" })).toEqual({
    workspaceId: "w2",
    paneId: "w2:p1",
  });
  expect(toCreatedSpace({ workspaceId: "w2" })).toBeNull();
  expect(toCreatedSpace({ workspaceId: "", paneId: "w2:p1" })).toBeNull();
  expect(toCreatedSpace({ workspaceId: "w2", paneId: 1 })).toBeNull();
  expect(toCreatedSpace(null)).toBeNull();
});

test("a worktree error keeps the ids only when the checkout already exists", () => {
  expect(
    toWorktreeError({ error: "pane_rename_failed", workspaceId: "w2", paneId: "w2:p1" }),
  ).toEqual({ error: "pane_rename_failed", workspaceId: "w2", paneId: "w2:p1" });
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

test("a space error keeps the ids only when the space already exists", () => {
  expect(toSpaceError({ error: "pane_rename_failed", workspaceId: "w3", paneId: "w3:p1" })).toEqual(
    { error: "pane_rename_failed", workspaceId: "w3", paneId: "w3:p1" },
  );
  expect(toSpaceError({ error: "not_found" })).toEqual({
    error: "not_found",
    workspaceId: null,
    paneId: null,
  });
  expect(toSpaceError({ error: "worktree_create_failed" })).toEqual({
    error: "failed",
    workspaceId: null,
    paneId: null,
  });
  expect(toSpaceError(null)).toEqual({ error: "failed", workspaceId: null, paneId: null });
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

test("the worktree timeout covers the worktree creation", () => {
  expect(CREATE_WORKTREE_TIMEOUT_MS).toBeGreaterThan(90_000);
});
