import { expect, expectTypeOf, test } from "bun:test";
import type { ClientResponse } from "hono/client";
import {
  CREATE_TIMEOUT_MS,
  MODEL_CREATE_TIMEOUT_MS,
  OUTPUT_LINES,
  attachmentUploadUrl,
  attachmentUrl,
  chatFileUrl,
  inputRequest,
  outputRequest,
  previewUrl,
  toCreateError,
  toCreatedPane,
  toModelInfo,
  toPaneInteraction,
  toPaneRead,
  toSpaceError,
  toStartError,
} from "./panes";
import { createApiClient, paneParam } from "../api";

const api = createApiClient("http://localhost");

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

test("model-specific creation also covers candidate lookup and session preparation", () => {
  expect(MODEL_CREATE_TIMEOUT_MS).toBeGreaterThan(CREATE_TIMEOUT_MS + 53_000);
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
