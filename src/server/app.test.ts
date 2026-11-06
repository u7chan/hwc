import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import type { ChatClient } from "./chat/pi";
import { createChatClient } from "./chat/pi";
import type { ChatSnapshot } from "./chat/contract";
import { OpencodeServiceNotRunningError } from "./chat/opencode";
import type { PaneClient } from "./herdr/panes";
import type { WorktreeClient } from "./herdr/worktrees";
import { HerdrError } from "./herdr/socket";
import type { AppState, ChatSource, PaneState, StateStore } from "./herdr/state";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments";
import { FOLDER_TRUST_SCREEN } from "../../e2e/fixtures/folder-trust";

const pane: PaneState = {
  id: "w1:p1",
  title: null,
  label: null,
  agent: null,
  agentStatus: "idle",
  focused: true,
  chat: false,
};

const state: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "idle",
      focused: true,
      worktree: null,
      tabs: [
        {
          id: "w1:t1",
          label: "main",
          agentStatus: "idle",
          focused: true,
          panes: [pane],
        },
      ],
    },
  ],
};

const workingPane: PaneState = { ...pane, agent: "pi", agentStatus: "working", chat: true };
const workingState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      agentStatus: "working",
      tabs: [{ ...state.workspaces[0]!.tabs[0]!, agentStatus: "working", panes: [workingPane] }],
    },
  ],
};

// linked worktree のスペース。チェックアウトの削除はここからだけ受け付ける。
const worktreeState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      worktree: {
        repoName: "hwc",
        repoRoot: "/project",
        checkoutPath: "/project-worktree",
        isLinkedWorktree: true,
      },
    },
  ],
};

const chatPane: PaneState = { ...pane, agent: "pi", chat: true };

const chatState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      tabs: [{ ...state.workspaces[0]!.tabs[0]!, panes: [chatPane] }],
    },
  ],
};

// 添付がペインごとに分かれていることを確かめるため、会話を持つペインを 2 枚持つ状態。
const twoChatPanesState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      tabs: [
        {
          ...state.workspaces[0]!.tabs[0]!,
          panes: [chatPane, { ...chatPane, id: "w1:p2" }],
        },
      ],
    },
  ],
};

const sessionPath = "/sessions/--home-dev--/2026-01-01.jsonl";
const otherSessionPath = "/sessions/--home-dev--/2026-01-02.jsonl";

type FakeStore = StateStore & {
  push: (state: AppState) => void;
  listenerCount: () => number;
  fireOnSubscribe: (state: AppState) => void;
  setChatSource: (paneId: string, source: ChatSource | null) => void;
};

function createFakeStore(initial: AppState | null, failure?: Error): FakeStore {
  const listeners = new Set<(state: AppState) => void>();
  const sources = new Map<string, ChatSource>();
  let current = initial;
  let pendingOnSubscribe: AppState | null = null;

  return {
    get: () => current,
    refresh: async () => {
      if (failure) throw failure;
      current ??= state;
      return current;
    },
    chatSource: (paneId) => sources.get(paneId) ?? null,
    onChange: (listener) => {
      listeners.add(listener);
      if (pendingOnSubscribe) {
        const pending = pendingOnSubscribe;
        pendingOnSubscribe = null;
        listener(pending);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
    fireOnSubscribe: (state) => {
      pendingOnSubscribe = state;
    },
    setChatSource: (paneId, source) => {
      if (source === null) sources.delete(paneId);
      else sources.set(paneId, source);
    },
    push: (next) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function createFakeChat(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    snapshot: async () => emptyChat,
    ...overrides,
  };
}

const emptyChat: ChatSnapshot = {
  etag: "etag-1",
  messages: [],
  model: null,
  effort: null,
  truncated: false,
  context: null,
  compaction: null,
};

function createFakePanes(overrides: Partial<PaneClient> = {}): PaneClient {
  return {
    read: async ({ paneId }) => ({ paneId, text: "hello\n", truncated: false, revision: 3 }),
    send: async () => {},
    focus: async () => {},
    stop: async () => {},
    confirmFolderTrust: async () => {},
    close: async () => {},
    exit: async () => {},
    layout: async ({ paneId }) => ({ cells: [{ paneId, width: 240, height: 48 }] }),
    directory: async () => "/project",
    split: async ({ paneId }) => ({ paneId }),
    startAgent: async () => {},
    rename: async () => {},
    ...overrides,
  };
}

function createFakeWorktrees(overrides: Partial<WorktreeClient> = {}): WorktreeClient {
  return {
    remove: async () => {},
    ...overrides,
  };
}

// どのテストも同じ BFF を叩く。テストごとに書くのは、そのテストが見たい差分だけにする。
type TestAppOptions = {
  state?: AppState | null;
  storeFailure?: Error;
  store?: FakeStore;
  panes?: Partial<PaneClient>;
  worktrees?: Partial<WorktreeClient>;
  chat?: Partial<ChatClient>;
} & Partial<
  Pick<
    Parameters<typeof createApp>[0],
    "models" | "opencode" | "codex" | "revision" | "sseHeartbeatMs" | "attachmentsRoot"
  >
>;

function createTestApp(options: TestAppOptions = {}) {
  const { state: initial = state, storeFailure, store, panes, worktrees, chat, ...rest } = options;
  const fakeStore = store ?? createFakeStore(initial, storeFailure);
  const app = createApp({
    store: fakeStore,
    panes: createFakePanes(panes),
    worktrees: createFakeWorktrees(worktrees),
    chat: createFakeChat(chat),
    ...rest,
  });
  return { app, store: fakeStore };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met in time");
}

function createSseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  type SseEvent = { event: string | null; data: string };

  return {
    async nextEvent(): Promise<SseEvent> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = raw.split("\n");
          const event =
            lines
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim() ?? null;
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (event || data) return { event, data };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async next(): Promise<AppState> {
      return JSON.parse((await this.nextEvent()).data) as AppState;
    },
    cancel: () => reader.cancel(),
  };
}

test("GET /api/health returns ok", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "hwc", revision: "dev" });
});

test("GET /api/health reports the revision it was built from", async () => {
  const { app } = createTestApp({ revision: "abc1234" });
  const response = await app.request("/api/health");

  expect(await response.json()).toEqual({ ok: true, service: "hwc", revision: "abc1234" });
});

test("GET /api/state returns the current state", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
});

test("GET /api/state loads the state when the store is still empty", async () => {
  const { app } = createTestApp({ state: null });
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
});

test("GET /api/state returns 502 when Herdr cannot be read", async () => {
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("socket closed"),
  });
  const response = await app.request("/api/state");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("GET /api/events streams the current state first, then every update", async () => {
  const store = createFakeStore(state);
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.next()).toEqual(state);

  const next: AppState = { ...state, focusedPaneId: null };
  store.push(next);
  expect(await events.next()).toEqual(next);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events stays open and sends the state once Herdr becomes readable", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.nextEvent()).toEqual({ event: "unavailable", data: "" });

  store.push(state);
  expect(await events.next()).toEqual(state);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events uses an update that arrived first instead of reporting unavailability", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  store.fireOnSubscribe(state);
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.nextEvent()).toMatchObject({ event: null });

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events flushes an update that arrives while the initial state is being sent", async () => {
  const store = createFakeStore(state);
  const next: AppState = { ...state, focusedPaneId: "w1:p9" };
  store.fireOnSubscribe(next);
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.next()).toEqual(state);
  expect(await events.next()).toEqual(next);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events keeps the stream alive with a heartbeat comment", async () => {
  const store = createFakeStore(state);
  const { app } = createTestApp({
    store,
    sseHeartbeatMs: 10,
  });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const deadline = Date.now() + 2_000;
  while (!received.includes(": ping") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }

  await reader.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);

  // 状態は先に届き、その後にコメント行が続く。
  expect(received).toContain(JSON.stringify(state));
  expect(received).toContain(": ping");
  // event: を付けると client の onmessage ではなく専用の listener に飛ぶ。付けてはいけない。
  expect(received).not.toContain("event: ping");
});

test("GET /api/events unsubscribes when the client is gone before the initial state is sent", async () => {
  const store = createFakeStore(state);
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");

  await response.body.cancel();
  controller.abort();

  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/panes/:id/output returns the pane output", async () => {
  const output = { paneId: "w1:p1", text: "hello\n", truncated: true, revision: 3 };
  const { app } = createTestApp({ panes: { read: async () => output } });
  const response = await app.request("/api/panes/w1:p1/output?lines=20");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...output, interaction: null });
});

test("GET /api/panes/:id/output forwards the parsed query to the pane client", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      read: async (options) => {
        seen.push(options);
        return { paneId: options.paneId, text: "", truncated: false, revision: 0 };
      },
    },
  });

  await app.request("/api/panes/w1:p1/output?source=visible&lines=5");

  expect(seen).toEqual([{ paneId: "w1:p1", source: "visible", lines: 5 }]);
});

// ペインを 1 枚触るルートは、状態を読んでから Herdr を呼び、失敗を同じ規則で HTTP に写す。
// 規則は BFF 側に 1 つしかないので、テストもルート横断で 1 つにする。
const paneActionCases = [
  { action: "output", method: "GET", call: "read", state, body: {}, guardsPane: true },
  // 添付の無い input は状態を読まずに Herdr へ送る。ペインの有無は Herdr が決める。
  { action: "input", method: "POST", call: "send", state, body: { text: "hi" }, guardsPane: false },
  { action: "stop", method: "POST", call: "stop", state: workingState, body: {}, guardsPane: true },
  { action: "focus", method: "POST", call: "focus", state, body: {}, guardsPane: true },
  {
    action: "close",
    method: "POST",
    call: "close",
    state: twoChatPanesState,
    body: {},
    guardsPane: true,
  },
  { action: "split", method: "POST", call: "layout", state, body: {}, guardsPane: true },
] as const;

function requestPaneAction(
  app: ReturnType<typeof createApp>,
  testCase: { action: string; method: string; body: unknown },
  paneId = "w1:p1",
) {
  return app.request(`/api/panes/${paneId}/${testCase.action}`, {
    method: testCase.method,
    headers: { "content-type": "application/json" },
    body: testCase.method === "POST" ? JSON.stringify(testCase.body) : undefined,
  });
}

// 呼ばれたこと自体を記録しておく。状態で止まるべきルートが Herdr まで進んだら分かる。
function failingPanes(
  method: keyof PaneClient,
  error: Error,
  calls: string[] = [],
): Partial<PaneClient> {
  return {
    [method]: async () => {
      calls.push(method);
      throw error;
    },
  } as Partial<PaneClient>;
}

test.each(paneActionCases.filter((testCase) => testCase.guardsPane))(
  "$action answers 404 for a pane the snapshot does not have, without asking Herdr",
  async (testCase) => {
    const calls: string[] = [];
    const { app } = createTestApp({
      state: testCase.state,
      panes: failingPanes(testCase.call, new Error("Herdr must not be called"), calls),
    });

    const response = await requestPaneAction(app, testCase, "w1:p9");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "pane_not_found" });
    expect(calls).toEqual([]);
  },
);

test.each(paneActionCases.filter((testCase) => testCase.guardsPane))(
  "$action answers 502 when the snapshot cannot be read",
  async (testCase) => {
    const { app } = createTestApp({ state: null, storeFailure: new Error("socket closed") });

    const response = await requestPaneAction(app, testCase);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "herdr_unavailable" });
  },
);

const paneFailures = paneActionCases.flatMap((testCase) =>
  [
    {
      kind: "pane_not_found",
      error: new HerdrError("pane_not_found", "no pane"),
      status: 404,
      expected: { error: "pane_not_found" },
    },
    {
      kind: "invalid_params",
      error: new HerdrError("invalid_params", "bad params"),
      status: 400,
      expected: { error: "invalid_request" },
    },
    {
      kind: "socket_closed",
      error: new HerdrError("socket_closed", "socket closed"),
      status: 502,
      expected: { error: "herdr_unavailable" },
    },
    {
      kind: "an unexpected error",
      error: new Error("socket closed"),
      status: 502,
      expected: { error: "herdr_unavailable" },
    },
  ].map((failure) => ({ ...testCase, ...failure })),
);

test.each(paneFailures)("$action maps $kind to $status", async (testCase) => {
  const { app } = createTestApp({
    state: testCase.state,
    panes: failingPanes(testCase.call, testCase.error),
  });

  const response = await requestPaneAction(app, testCase);

  expect(response.status).toBe(testCase.status);
  expect(await response.json()).toEqual(testCase.expected);
});

function folderTrustApp(sendFailure?: Error) {
  let screen = FOLDER_TRUST_SCREEN;
  let sends = 0;
  let inputs = 0;
  let stops = 0;
  const codexPane = { ...pane, agent: "codex", chat: true, agentStatus: "working" as const };
  const codexState: AppState = {
    ...state,
    workspaces: [
      { ...state.workspaces[0]!, tabs: [{ ...state.workspaces[0]!.tabs[0]!, panes: [codexPane] }] },
    ],
  };
  const store = createFakeStore(codexState);
  const { app } = createTestApp({
    store,
    panes: {
      read: async ({ paneId, source }) => ({
        paneId,
        text: source === "detection" ? screen : "terminal output",
        truncated: false,
        revision: 0,
      }),
      confirmFolderTrust: async () => {
        sends += 1;
        if (sendFailure) throw sendFailure;
      },
      send: async () => {
        inputs += 1;
      },
      stop: async () => {
        stops += 1;
      },
    },
  });
  const inspect = async () =>
    (await (await app.request("/api/panes/w1:p1/output")).json()) as {
      interaction: { id: string; submitted: boolean } | null;
    };
  const confirm = (id: unknown) =>
    app.request("/api/panes/w1:p1/confirm-folder-trust", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  return {
    app,
    inspect,
    confirm,
    store,
    setScreen: (text: string) => {
      screen = text;
    },
    counts: () => ({ sends, inputs, stops }),
  };
}

test("output reports a server-issued folder confirmation independently of the conversation", async () => {
  const fixture = folderTrustApp();
  const first = await fixture.inspect();
  expect(first).toMatchObject({
    interaction: {
      kind: "codex-folder-trust",
      directory: "/workspace/acme-dashboard",
      submitted: false,
    },
  });
  expect((await fixture.inspect()).interaction?.id).toBe(first.interaction!.id);
  expect(fixture.counts()).toEqual({ sends: 0, inputs: 0, stops: 0 });
});

test("a valid confirmation succeeds once and does not optimistically clear the prompt", async () => {
  const fixture = folderTrustApp();
  const { interaction } = await fixture.inspect();
  const results = await Promise.all([
    fixture.confirm(interaction!.id),
    fixture.confirm(interaction!.id),
  ]);
  expect(results.map((result) => result.status)).toEqual([200, 409]);
  expect((await fixture.inspect()).interaction?.submitted).toBe(true);
  expect(fixture.counts().sends).toBe(1);
  fixture.setScreen("Codex is ready");
  expect((await fixture.inspect()).interaction).toBeNull();
});

test("a 502 followed by an empty detection frame never issues a second usable approval", async () => {
  const fixture = folderTrustApp(new Error("unknown send outcome"));
  const { interaction } = await fixture.inspect();
  expect((await fixture.confirm(interaction!.id)).status).toBe(502);
  fixture.setScreen("");
  expect((await fixture.inspect()).interaction).toHaveProperty("kind", "terminal");
  expect((await fixture.inspect()).interaction).not.toHaveProperty("id");
  expect((await fixture.confirm(interaction!.id)).status).toBe(409);
  for (const action of ["input", "stop"]) {
    const response = await fixture.app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", submit: true }),
    });
    expect(response.status).toBe(409);
  }
  fixture.setScreen(FOLDER_TRUST_SCREEN);
  expect((await fixture.inspect()).interaction).toMatchObject({
    id: interaction!.id,
    submitted: true,
  });
  expect((await fixture.confirm((await fixture.inspect()).interaction!.id)).status).toBe(409);
  expect(fixture.counts()).toEqual({ sends: 1, inputs: 0, stops: 0 });
});

test("confirmation rejects malformed, forged and stale identifiers without sending keys", async () => {
  const fixture = folderTrustApp();
  for (const id of [null, false, 0, "", [], {}])
    expect((await fixture.confirm(id)).status).toBe(400);
  expect((await fixture.confirm("forged")).status).toBe(409);
  const { interaction } = await fixture.inspect();
  fixture.setScreen(FOLDER_TRUST_SCREEN.replace("acme-dashboard", "other-project"));
  expect((await fixture.confirm(interaction!.id)).status).toBe(409);
  expect(fixture.counts().sends).toBe(0);
});

test("approval refreshes agent identity and rejects a pane that is no longer Codex", async () => {
  const fixture = folderTrustApp();
  const { interaction } = await fixture.inspect();
  fixture.store.push(state);
  expect((await fixture.confirm(interaction!.id)).status).toBe(409);
  expect(fixture.counts().sends).toBe(0);
});

test("message and stop requests cannot answer or cancel the pending trust screen", async () => {
  const fixture = folderTrustApp();
  for (const action of ["input", "stop"]) {
    const response = await fixture.app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", submit: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "confirmation_pending" });
  }
  expect(fixture.counts()).toEqual({ sends: 0, inputs: 0, stops: 0 });
});

test("confirmation returns 404 for absent panes and 502 if authoritative state is unavailable", async () => {
  const fixture = folderTrustApp();
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "old" }),
  };
  expect((await fixture.app.request("/api/panes/w1:p9/confirm-folder-trust", request)).status).toBe(
    404,
  );
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("offline"),
  });
  expect((await app.request("/api/panes/w1:p1/confirm-folder-trust", request)).status).toBe(502);
});

const jsonPaneActions = [
  "input",
  "stop",
  "focus",
  "close",
  "exit",
  "split",
  "confirm-folder-trust",
] as const;

test.each(jsonPaneActions)(
  "POST /api/panes/:id/%s rejects non-JSON before reading the body or state",
  async (action) => {
    let stateReads = 0;
    const store = createFakeStore(workingState);
    const { app } = createTestApp({
      store: {
        ...store,
        get: () => {
          stateReads += 1;
          return store.get();
        },
      },
    });

    for (const contentType of [
      undefined,
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=example",
      "application/jsonx",
      "application/json-patch+json",
    ]) {
      const request = new Request(`http://localhost/api/panes/w1:p1/${action}`, {
        method: "POST",
        headers: contentType === undefined ? {} : { "content-type": contentType },
        body: new TextEncoder().encode("not json"),
      });
      const response = await app.request(request);

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "content-type must be application/json" });
      expect(request.bodyUsed).toBe(false);
    }
    expect(stateReads).toBe(0);
  },
);

test.each(jsonPaneActions.filter((action) => action !== "confirm-folder-trust"))(
  "POST /api/panes/:id/%s accepts JSON media types regardless of case or parameters",
  async (action) => {
    const { app } = createTestApp({ state: action === "close" ? twoChatPanesState : workingState });

    for (const contentType of ["application/json", "Application/JSON; Charset=utf-8"]) {
      const response = await app.request(`/api/panes/w1:p1/${action}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(response.status).toBe(200);
    }
  },
);

test.each(["application/json", "Application/JSON; Charset=utf-8"])(
  "folder confirmation accepts the JSON media type %s",
  async (contentType) => {
    const fixture = folderTrustApp();
    const { interaction } = await fixture.inspect();
    const response = await fixture.app.request("/api/panes/w1:p1/confirm-folder-trust", {
      method: "POST",
      headers: { "content-type": contentType },
      body: JSON.stringify({ id: interaction!.id }),
    });
    expect(response.status).toBe(200);
  },
);

test.each(["stop", "focus", "close", "exit"])(
  "POST /api/panes/:id/%s does not parse a body it does not need",
  async (action) => {
    const { app } = createTestApp({ state: action === "close" ? twoChatPanesState : workingState });
    const request = new Request(`http://localhost/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await app.request(request);

    expect(response.status).toBe(200);
    expect(request.bodyUsed).toBe(false);
  },
);

test.each(["stop", "focus", "split"])(
  "POST /api/panes/:id/%s leaves snapshot refresh to Herdr events",
  async (action) => {
    let refreshes = 0;
    const store = createFakeStore(workingState);
    const { app } = createTestApp({
      store: {
        ...store,
        refresh: async () => {
          refreshes += 1;
          throw new Error("socket closed");
        },
      },
    });
    const response = await app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(refreshes).toBe(0);
  },
);

test("POST /api/panes/:id/input without attachments does not need a snapshot", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("socket closed"),
    panes: {
      send: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", submit: true }),
  });

  expect(response.status).toBe(200);
  expect(seen).toEqual([{ paneId: "w1:p1", text: "hello", submit: true }]);
});

test("POST /api/panes/:id/input sends the text and submits it", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      send: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ls -la", submit: true }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ paneId: "w1:p1", text: "ls -la", submit: true }]);
});

test("POST /api/panes/:id/input rejects a body that is not JSON", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "body must be an object" });
});

test("POST /api/panes/:id/input sends without submit", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      send: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ls" }),
  });

  expect(response.status).toBe(200);
  expect(seen).toEqual([{ paneId: "w1:p1", text: "ls", submit: false }]);
});

test("POST /api/panes/:id/input rejects a text that is too long", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "a".repeat(16_385) }),
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "text must be at most 16384 bytes" });
});

test("GET /api/panes/:id/output rejects an unknown source", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/panes/w1:p1/output?source=scrollback");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "source must be one of visible, recent, recent_unwrapped, detection",
  });
});

test("POST /api/panes/:id/stop sends Escape to a working pane", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: workingState,
    panes: {
      stop: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ paneId: "w1:p1" }]);
});

test("POST /api/panes/:id/stop does not send Escape to a pane that is not working", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      stop: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([]);
});

test("POST /api/panes/:id/focus focuses the pane by id", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      focus: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/focus", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ paneId: "w1:p1" }]);
});

test("POST /api/panes/:id/close closes the pane by id", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      close: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ paneId: "w1:p1" }]);
});

test.each([state, chatState, workingState])(
  "close refuses the last pane without closing or exiting it",
  async (initial) => {
    const seen: string[] = [];
    const { app } = createTestApp({
      state: initial,
      panes: {
        close: async () => {
          seen.push("close");
        },
        exit: async () => {
          seen.push("exit");
        },
      },
    });
    const response = await app.request("/api/panes/w1:p1/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "pane_action_changed" });
    expect(seen).toEqual([]);
  },
);

test.each(["close", "exit"])(
  "%s refreshes before checking the action, but not after sending it",
  async (action) => {
    let refreshes = 0;
    const initial = action === "close" ? twoChatPanesState : chatState;
    const store = createFakeStore(initial);
    const { app } = createTestApp({
      store: {
        ...store,
        refresh: async () => {
          refreshes += 1;
          return initial;
        },
      },
    });
    const response = await app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(refreshes).toBe(1);
  },
);

test("close rechecks a stale snapshot and refuses what is now the last pane", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    store: { ...createFakeStore(twoChatPanesState), refresh: async () => chatState },
    panes: {
      close: async () => {
        seen.push("close");
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(409);
  expect(seen).toEqual([]);
});

test.each(["close", "exit"])(
  "%s never uses a cached snapshot when refreshing fails",
  async (action) => {
    const seen: string[] = [];
    const { app } = createTestApp({
      state: action === "close" ? twoChatPanesState : chatState,
      storeFailure: new Error("socket closed"),
      panes: {
        close: async () => {
          seen.push("close");
        },
        exit: async () => {
          seen.push("exit");
        },
      },
    });
    const response = await app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(502);
    expect(seen).toEqual([]);
  },
);

test("a failed close does not prevent subsequent requests from being checked", async () => {
  let attempts = 0;
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      close: async () => {
        attempts += 1;
        if (attempts === 1) throw new HerdrError("socket_closed", "socket closed");
      },
    },
  });
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await app.request("/api/panes/w1:p1/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    statuses.push(response.status);
  }
  expect(statuses).toEqual([502, 200]);
});

test("simultaneous closes cannot both remove the two remaining panes", async () => {
  const store = createFakeStore(twoChatPanesState);
  const seen: string[] = [];
  const { app } = createTestApp({
    store,
    panes: {
      close: async ({ paneId }) => {
        seen.push(paneId);
        store.push({
          ...chatState,
          workspaces: [
            {
              ...chatState.workspaces[0]!,
              tabs: [
                {
                  ...chatState.workspaces[0]!.tabs[0]!,
                  panes: [{ ...chatPane, id: "w1:p2" }],
                },
              ],
            },
          ],
        });
      },
    },
  });
  const responses = await Promise.all(
    ["w1:p1", "w1:p2"].map((id) =>
      app.request(`/api/panes/${id}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual([200, 409]);
  expect(seen).toEqual(["w1:p1"]);
});

test("exit requests agent shutdown while leaving the last pane and selection intact", async () => {
  const store = createFakeStore(chatState);
  const seen: unknown[] = [];
  const { app } = createTestApp({
    store,
    panes: {
      exit: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/exit", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(200);
  expect(seen).toEqual([{ paneId: "w1:p1" }]);
  expect(store.get()).toEqual(chatState);
});

test.each([state, twoChatPanesState])(
  "exit rejects a shell or an action that no longer matches the space",
  async (initial) => {
    const seen: string[] = [];
    const { app } = createTestApp({
      state: initial,
      panes: {
        exit: async () => {
          seen.push("exit");
        },
      },
    });
    const response = await app.request("/api/panes/w1:p1/exit", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
    expect(seen).toEqual([]);
  },
);

test.each([
  ["agent_exit_unsafe", 409],
  ["pane_not_found", 404],
  ["agent_not_ready", 502],
  ["agent_blocked", 502],
] as const)("exit maps %s without falling back to close", async (code, status) => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state: chatState,
    panes: {
      exit: async () => {
        throw new HerdrError(code, "cannot exit");
      },
      close: async () => {
        seen.push("close");
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/exit", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(status);
  expect(seen).toEqual([]);
});

test("POST /api/workspaces/:id/remove-worktree deletes a linked checkout", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: worktreeState,
    worktrees: {
      remove: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ workspaceId: "w1" }]);
});

test("remove-worktree refuses a workspace that is not a linked checkout", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state,
    worktrees: {
      remove: async () => {
        seen.push("remove");
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_linked_worktree" });
  expect(seen).toEqual([]);
});

test("remove-worktree requires application/json", async () => {
  const { app } = createTestApp({ state: worktreeState });
  const response = await app.request("/api/workspaces/w1/remove-worktree", { method: "POST" });

  expect(response.status).toBe(415);
});

test("remove-worktree reports a workspace that is no longer listed", async () => {
  const { app } = createTestApp({ state: worktreeState });
  const response = await app.request("/api/workspaces/w9/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "workspace_not_found" });
});

// 消えたチェックアウトは目的の状態に達している。それ以外の拒否は 409 で区別する。
test.each([
  ["not_linked_worktree", 409],
  ["workspace_not_found", 404],
  ["worktree_not_found", 404],
  ["worktree_remove_failed", 502],
] as const)("remove-worktree maps %s", async (code, status) => {
  const { app } = createTestApp({
    state: worktreeState,
    worktrees: {
      remove: async () => {
        throw new HerdrError(code, "cannot remove");
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(status);
});

function createChatApp(options: { store?: FakeStore; chat?: ChatClient } = {}) {
  const { app, store } = createTestApp({
    store: options.store,
    state: chatState,
    chat: options.chat,
  });
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  return app;
}

test("GET /api/panes/:id/chat returns the conversation of the pane session", async () => {
  const messages = [{ id: "a1", role: "user" as const, text: "hello", at: 1_700_000_000_000 }];
  const context = { tokens: 122_600, window: 1_000_000 };
  const seen: string[] = [];
  const chat = createFakeChat({
    snapshot: async (path) => {
      seen.push(path);
      return { ...emptyChat, messages, context };
    },
  });
  const app = createChatApp({ chat });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...emptyChat, messages, context });
  expect(response.headers.get("etag")).toBe(`"${emptyChat.etag}"`);
  expect(seen).toEqual([sessionPath]);
});

test.each(["codex", "opencode"] as const)(
  "GET /api/panes/:id/chat reads a %s session through its own client",
  async (agent) => {
    const store = createFakeStore(chatState);
    store.setChatSource("w1:p1", { agent, sessionId: "ses_abc" });
    const seen: string[] = [];
    const client = createFakeChat({
      snapshot: async (sessionId) => {
        seen.push(sessionId);
        return { ...emptyChat, etag: agent };
      },
    });
    const { app } = createTestApp({
      store,
      chat: createFakeChat({
        snapshot: async () => {
          throw new Error("the pi client must not read another agent's session");
        },
      }),
      [agent]: client,
    });

    const response = await app.request("/api/panes/w1:p1/chat");

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"${agent}"`);
    expect(seen).toEqual(["ses_abc"]);
    const unchanged = await app.request("/api/panes/w1:p1/chat", {
      headers: { "if-none-match": `W/"${agent}"` },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  },
);

test.each(["codex", "opencode"] as const)(
  "GET /api/panes/:id/chat returns 502 when the %s client is not configured",
  async (agent) => {
    const store = createFakeStore(chatState);
    store.setChatSource("w1:p1", { agent, sessionId: "ses_abc" });
    const { app } = createTestApp({ store });

    const response = await app.request("/api/panes/w1:p1/chat");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "chat_unavailable" });
  },
);

test("GET /api/panes/:id/chat answers 304 for a matching weak or listed If-None-Match", async () => {
  const app = createChatApp();

  const weak = await app.request("/api/panes/w1:p1/chat", {
    headers: { "if-none-match": 'W/"etag-1"' },
  });
  expect(weak.status).toBe(304);
  expect(weak.headers.get("etag")).toBe('"etag-1"');
  expect(await weak.text()).toBe("");

  const listed = await app.request("/api/panes/w1:p1/chat", {
    headers: { "if-none-match": '"other", "etag-1"' },
  });
  expect(listed.status).toBe(304);

  const any = await app.request("/api/panes/w1:p1/chat", { headers: { "if-none-match": "*" } });
  expect(any.status).toBe(304);
});

test("GET /api/panes/:id/chat returns the snapshot when the If-None-Match is stale", async () => {
  const app = createChatApp();

  const response = await app.request("/api/panes/w1:p1/chat", {
    headers: { "if-none-match": '"older"' },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(emptyChat);
});

test("GET /api/panes/:id/chat returns 404 pane_not_found for a pane that is gone", async () => {
  const app = createChatApp();

  const response = await app.request("/api/panes/w1:p9/chat");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "pane_not_found" });
});

test("GET /api/panes/:id/chat returns 404 no_chat for a pane without a session", async () => {
  const store = createFakeStore(state);
  const app = createChatApp({ store });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "no_chat" });
});

test("GET /api/panes/:id/chat returns 404 no_chat when the store has no chat source", async () => {
  const store = createFakeStore(chatState);
  const { app } = createTestApp({ store });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "no_chat" });
});

test("GET /api/panes/:id/chat returns 502 when the state cannot be read", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  const { app } = createTestApp({ store });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("GET /api/panes/:id/chat returns 502 when the session cannot be read", async () => {
  const chat = createFakeChat({
    snapshot: async () => {
      throw new Error("session version 2 is not supported");
    },
  });
  const app = createChatApp({ chat });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "chat_unavailable" });
});

test("GET /api/panes/:id/chat returns an empty conversation for a session that is not written yet", async () => {
  const app = createChatApp({ chat: createChatClient() });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ messages: [], truncated: false });
});

test("GET /api/panes/:id/chat reads a session once for concurrent requests", async () => {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = createChatClient({
    load: async () => {
      reads += 1;
      await gate;
      return emptyChat;
    },
  });
  const app = createChatApp({ chat });

  const first = app.request("/api/panes/w1:p1/chat");
  const second = app.request("/api/panes/w1:p1/chat");
  await Bun.sleep(20);
  expect(reads).toBe(1);
  release();

  const responses = await Promise.all([first, second]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
});

test("GET /api/panes/:id/chat returns 200 after the pane session switched", async () => {
  const store = createFakeStore(chatState);
  const seen: string[] = [];
  const chat = createFakeChat({
    snapshot: async (path) => {
      seen.push(path);
      return { ...emptyChat, etag: `etag-${seen.length}` };
    },
  });
  const { app } = createTestApp({
    store,
    chat: chat,
  });
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });

  const first = await app.request("/api/panes/w1:p1/chat");
  store.setChatSource("w1:p1", {
    agent: "pi",
    path: "/sessions/--home-dev--/2026-02-02.jsonl",
  });
  const second = await app.request("/api/panes/w1:p1/chat", {
    headers: { "if-none-match": first.headers.get("etag") ?? "" },
  });

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(seen).toEqual([sessionPath, "/sessions/--home-dev--/2026-02-02.jsonl"]);
});

test("GET /api/panes/:id/chat answers 304 while the session file stays gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hwc-chat-"));
  const file = join(dir, "session.jsonl");
  const lines = [
    { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hello", timestamp: 1_700_000_000_000 },
    },
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  try {
    const store = createFakeStore(chatState);
    store.setChatSource("w1:p1", { agent: "pi", path: file });
    const { app } = createTestApp({
      store,
      chat: createChatClient(),
    });

    const first = await app.request("/api/panes/w1:p1/chat");
    expect(first.status).toBe(200);

    await rm(file);
    const gone = await app.request("/api/panes/w1:p1/chat", {
      headers: { "if-none-match": first.headers.get("etag") ?? "" },
    });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ messages: [], truncated: false });

    const repeated = await app.request("/api/panes/w1:p1/chat", {
      headers: { "if-none-match": gone.headers.get("etag") ?? "" },
    });
    expect(repeated.status).toBe(304);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/panes/:id/chat returns 200 for a catalog-only window change and 304 for other models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hwc-chat-"));
  try {
    const sessions = join(dir, "sessions", "demo");
    await mkdir(sessions, { recursive: true });
    const file = join(sessions, "session.jsonl");
    const lines = [
      { type: "session", version: 3, id: "session-1" },
      {
        type: "message",
        id: "a1",
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          provider: "p",
          model: "m",
          usage: { totalTokens: 1_000 },
        },
      },
    ];
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const catalogFile = join(dir, "models-store.json");
    const catalog = (window: number, other = 100_000) => ({
      p: {
        models: [
          { id: "m", contextWindow: window },
          { id: "other", contextWindow: other },
        ],
      },
    });
    await writeFile(catalogFile, JSON.stringify(catalog(100_000)));
    const store = createFakeStore(chatState);
    store.setChatSource("w1:p1", { agent: "pi", path: file });
    const { app } = createTestApp({
      store,
      chat: createChatClient(),
    });
    const request = (etag: string | null) =>
      app.request("/api/panes/w1:p1/chat", { headers: { "if-none-match": etag ?? "" } });

    const first = await request(null);
    expect(first.status).toBe(200);
    const before = (await first.json()) as ChatSnapshot;
    expect(before.context).toEqual({ tokens: 1_000, window: 100_000 });
    expect((await request(first.headers.get("etag"))).status).toBe(304);

    await writeFile(catalogFile, JSON.stringify(catalog(1_000_000)));
    const changed = await request(first.headers.get("etag"));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(first.headers.get("etag"));
    expect(await changed.json()).toMatchObject({
      context: { tokens: 1_000, window: 1_000_000 },
      messages: before.messages,
      model: before.model,
    });
    expect((await request(changed.headers.get("etag"))).status).toBe(304);

    await writeFile(catalogFile, JSON.stringify(catalog(1_000_000, 200_000)));
    expect((await request(changed.headers.get("etag"))).status).toBe(304);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 保存先は外から差し替える。実ホームの状態ディレクトリへ書かせない。
async function withAttachmentsRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hwc-attachments-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createAttachmentApp(
  root: string,
  options: { state?: AppState; panes?: Partial<PaneClient> } = {},
): ReturnType<typeof createApp> {
  return createTestApp({
    state: options.state ?? chatState,
    panes: options.panes,
    attachmentsRoot: root,
  }).app;
}

async function uploadImage(
  app: ReturnType<typeof createApp>,
  options: {
    paneId?: string;
    type?: string;
    body?: Uint8Array<ArrayBuffer>;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return app.request(`/api/panes/${options.paneId ?? "w1:p1"}/attachments`, {
    method: "POST",
    headers: {
      "content-type": options.type ?? "image/png",
      ...options.headers,
    },
    body: options.body ?? pngBytes,
  });
}

const savedName = /^pasted-\d{8}-\d{6}(-\d+)?\.png$/;

test("POST /api/panes/:id/attachments saves the image under the pane", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const response = await uploadImage(app);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { name: string };
    expect(body.name).toMatch(savedName);
    expect(await readFile(join(root, "w1:p1", body.name))).toEqual(Buffer.from(pngBytes));

    // 続けて貼った画像は上書きせず、別の名前になる。
    const second = (await (await uploadImage(app)).json()) as { name: string };
    expect(second.name).toMatch(savedName);
    expect(second.name).not.toBe(body.name);
  });
});

test("POST /api/panes/:id/attachments refuses a type outside the allowlist before the body", async () => {
  await withAttachmentsRoot(async (root) => {
    // ペインが無くても型の判定が先。simple request は preflight を通らないため。
    for (const type of ["image/svg+xml", "image/gif", "text/plain", "application/octet-stream"]) {
      const app = createAttachmentApp(root, { state });
      const response = await uploadImage(app, { type });
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "unsupported_media_type" });
    }
  });
});

test("POST /api/panes/:id/attachments returns 404 for a pane that is gone or has no chat", async () => {
  await withAttachmentsRoot(async (root) => {
    const missing = await uploadImage(createAttachmentApp(root), { paneId: "w1:p9" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "pane_not_found" });

    const noChat = await uploadImage(createAttachmentApp(root, { state }));
    expect(noChat.status).toBe(404);
    expect(await noChat.json()).toEqual({ error: "no_chat" });
  });
});

test("POST /api/panes/:id/attachments refuses a pane id that would escape the root", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);

    // %2e%2e は URL の解決で消える。%2F は残るので、デコードすると区切りを含む id になる。
    for (const paneId of ["%2e%2e", "..%2F..", "..%2F..%2Ftmp"]) {
      const response = await uploadImage(app, { paneId });
      expect(response.status).toBe(404);
    }
    // どこにも書いていない。
    expect(await readdir(root)).toEqual([]);
  });
});

test("POST /api/panes/:id/attachments stops an oversized image before reading it", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const response = await uploadImage(app, {
      headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "attachment_too_large" });
  });
});

test("POST /api/panes/:id/attachments accepts exactly the size limit and refuses one byte more", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);

    const atLimit = await uploadImage(app, { body: new Uint8Array(MAX_ATTACHMENT_BYTES) });
    expect(atLimit.status).toBe(200);

    const over = await uploadImage(app, { body: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) });
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "attachment_too_large" });
  });
});

test("POST /api/panes/:id/attachments counts the bytes it actually read", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    // Content-Length を持たない chunked の body。事前検査を通らず、読んだバイト数だけで落ちる。
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const request = new Request("http://localhost/api/panes/w1:p1/attachments", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > MAX_ATTACHMENT_BYTES) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        },
      }),
      // ストリームの body は長さが決まらないので duplex が要る。
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "attachment_too_large" });
  });
});

test("POST /api/panes/:id/attachments rejects an empty body", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const response = await uploadImage(app, { body: new Uint8Array(0) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});

test("GET /api/panes/:id/attachments/:name serves the saved image as immutable", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const { name } = (await (await uploadImage(app)).json()) as { name: string };

    const response = await app.request(`/api/panes/w1:p1/attachments/${name}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
  });
});

test("GET /api/panes/:id/attachments/:name returns 400 for a name outside the format", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);

    // %2F は URL の解決で消えないので、デコードすると "../" を含む名前になる。
    for (const name of [
      "notes.png",
      "pasted-20261103-120000.gif",
      "..%2Fpasted-20261103-120000.png",
    ]) {
      const response = await app.request(`/api/panes/w1:p1/attachments/${name}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });
});

test("GET /api/panes/:id/attachments/:name returns 404 for a name this pane never saved", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root, { state: twoChatPanesState });

    const absent = await app.request("/api/panes/w1:p1/attachments/pasted-20200101-000000.png");
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: "not_found" });

    // 別のペイン（state に実在する w1:p2）にだけ置いた名前は、w1:p1 からは開けない。
    const { name } = (await (await uploadImage(app, { paneId: "w1:p2" })).json()) as {
      name: string;
    };
    const own = await app.request(`/api/panes/w1:p2/attachments/${name}`);
    expect(own.status).toBe(200);

    const crossPane = await app.request(`/api/panes/w1:p1/attachments/${name}`);
    expect(crossPane.status).toBe(404);
    expect(await crossPane.json()).toEqual({ error: "not_found" });
  });
});

test("GET /api/panes/:id/attachments/:name returns 404 no_chat for a pane without a session", async () => {
  await withAttachmentsRoot(async (root) => {
    const response = await createAttachmentApp(root, { state }).request(
      "/api/panes/w1:p1/attachments/pasted-20261103-120000.png",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no_chat" });
  });
});

test("POST /api/panes/:id/input appends the saved paths as a note", async () => {
  await withAttachmentsRoot(async (root) => {
    const seen: unknown[] = [];
    const app = createAttachmentApp(root, {
      panes: {
        send: async (options) => {
          seen.push(options);
        },
      },
    });
    const { name } = (await (await uploadImage(app)).json()) as { name: string };

    const response = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "look at this", submit: true, attachments: [name] }),
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        paneId: "w1:p1",
        text: `look at this\n\n<attached_files>\n- ${join(root, "w1:p1", name)}\n</attached_files>`,
        submit: true,
      },
    ]);
  });
});

test("POST /api/panes/:id/input accepts a message made of the images only", async () => {
  await withAttachmentsRoot(async (root) => {
    const seen: unknown[] = [];
    const app = createAttachmentApp(root, {
      panes: {
        send: async (options) => {
          seen.push(options);
        },
      },
    });
    const { name } = (await (await uploadImage(app)).json()) as { name: string };

    const response = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", submit: true, attachments: [name] }),
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        paneId: "w1:p1",
        text: `<attached_files>\n- ${join(root, "w1:p1", name)}\n</attached_files>`,
        submit: true,
      },
    ]);
  });
});

test("POST /api/panes/:id/input rejects an attachment this pane never saved", async () => {
  await withAttachmentsRoot(async (root) => {
    const sent: unknown[] = [];
    const app = createAttachmentApp(root, {
      panes: {
        send: async (options) => {
          sent.push(options);
        },
      },
    });

    const absent = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "hi",
        submit: true,
        attachments: ["pasted-20200101-000000.png"],
      }),
    });
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ error: "invalid_request" });

    const outside = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "hi",
        submit: true,
        attachments: ["../pasted-20200101-000000.png"],
      }),
    });
    expect(outside.status).toBe(400);
    expect(await outside.json()).toEqual({
      error: "attachments must be an array of attachment names",
    });
    expect(sent).toEqual([]);
  });
});

test("POST /api/panes/:id/input counts the note towards the size limit", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const { name } = (await (await uploadImage(app)).json()) as { name: string };

    // 注記の分だけ本文に書ける量が減る。素の本文なら収まる長さで確かめる。
    const note = `<attached_files>\n- ${join(root, "w1:p1", name)}\n</attached_files>`;
    const text = "a".repeat(16_384 - note.length - 1);

    const plain = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, submit: true }),
    });
    expect(plain.status).toBe(200);

    const response = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, submit: true, attachments: [name] }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "text and the attached files note must be at most 16384 bytes",
    });
  });
});

test("POST /api/panes/:id/input returns 404 for the pane that holds the images", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root, { state });

    const noChat = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", submit: true, attachments: ["pasted-20261103-120000.png"] }),
    });
    expect(noChat.status).toBe(404);
    expect(await noChat.json()).toEqual({ error: "no_chat" });

    const missing = await app.request("/api/panes/w1:p9/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", submit: true, attachments: ["pasted-20261103-120000.png"] }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "pane_not_found" });
  });
});

const fourPaneState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      tabs: [
        {
          ...state.workspaces[0]!.tabs[0]!,
          panes: [
            pane,
            { ...pane, id: "w1:p2" },
            { ...pane, id: "w1:p3" },
            { ...pane, id: "w1:p4" },
          ],
        },
      ],
    },
  ],
};

function postSplit(app: ReturnType<typeof createApp>, paneId: string, body: unknown = {}) {
  return app.request(`/api/panes/${paneId}/split`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 新しいペインにモデルを指定して作るアプリ。作成先の w1:p2 は最初から状態にある。
function launchModelApp() {
  const store = createFakeStore(twoChatPanesState);
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  const app = createApp({
    store,
    chat: createFakeChat(),
    worktrees: createFakeWorktrees(),
    panes: createFakePanes({ split: async () => ({ paneId: "w1:p2" }) }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });
  const split = () =>
    postSplit(app, "w1:p1", {
      agent: "pi",
      model: { provider: "example", id: "beam" },
      effort: "low",
    });
  return { app, split };
}

test.each(["pi", "codex", "opencode"] as const)(
  "GET /api/panes/:id/models lists %s candidates in the pane's directory",
  async (agent) => {
    const seen: unknown[] = [];
    const { app } = createTestApp({
      models: {
        efforts: async () => [],
        list: async (...args) => {
          seen.push(args);
          return [{ provider: "example", id: "beam" }];
        },
        startArgs: async () => {
          throw new Error("Reading must not create a session");
        },
      },
    });
    const response = await app.request(`/api/panes/w1:p1/models?agent=${agent}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [{ provider: "example", id: "beam" }] });
    expect(seen).toEqual([[agent, "/project"]]);
  },
);

test.each(["pi", "codex", "opencode"] as const)(
  "GET /api/panes/:id/efforts reads %s choices for the explicit model in the pane's directory",
  async (agent) => {
    const seen: unknown[] = [];
    const { app } = createTestApp({
      models: {
        list: async () => [],
        efforts: async (...args) => {
          seen.push(args);
          return ["eco", "max"];
        },
        startArgs: async () => {
          throw new Error("Reading must not create a session");
        },
      },
    });
    const query = new URLSearchParams({ agent, provider: "example", model: "@demo/beam" });
    const response = await app.request(`/api/panes/w1:p1/efforts?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ efforts: ["eco", "max"] });
    expect(seen).toEqual([[agent, { provider: "example", id: "@demo/beam" }, "/project"]]);
  },
);

test.each([
  "agent=claude&provider=example&model=beam",
  "agent=pi",
  "agent=pi&provider=example&model=--help",
])("GET /api/panes/:id/efforts rejects an invalid or missing model: %s", async (query) => {
  const { app } = createTestApp();
  expect((await app.request(`/api/panes/w1:p1/efforts?${query}`)).status).toBe(400);
});

test("GET /api/panes/:id/efforts preserves unsupported choices and hides upstream errors", async () => {
  let fail = false;
  const { app } = createTestApp({
    models: {
      list: async () => [],
      efforts: async () => {
        if (fail) throw new Error("/private/path: credentials");
        return [];
      },
      startArgs: async () => [],
    },
  });
  const path = "/api/panes/w1:p1/efforts?agent=pi&provider=example&model=beam";
  const unsupported = await app.request(path);
  expect(unsupported.status).toBe(200);
  expect(await unsupported.json()).toEqual({ efforts: [] });
  fail = true;
  const unavailable = await app.request(path);
  expect(unavailable.status).toBe(502);
  expect(await unavailable.json()).toEqual({ error: "efforts_unavailable" });
});

test("GET /api/panes/:id/efforts requires an existing pane, a snapshot, and a model client", async () => {
  const { app } = createTestApp();
  const query = "?agent=pi&provider=example&model=beam";
  expect((await app.request(`/api/panes/w1:p9/efforts${query}`)).status).toBe(404);
  expect((await app.request(`/api/panes/w1:p1/efforts${query}`)).status).toBe(502);
  const unavailable = createTestApp({ state: null, storeFailure: new Error("unavailable") }).app;
  expect((await unavailable.request(`/api/panes/w1:p1/efforts${query}`)).status).toBe(502);
});

test.each(["pi", "codex", "opencode"] as const)(
  "POST /api/panes/:id/split passes the selected %s effort only to the new pane",
  async (kind) => {
    const model = { provider: "example", id: "beam" };
    const seen: unknown[] = [];
    const { app } = createTestApp({
      panes: {
        split: async () => ({ paneId: "w1:p2" }),
        startAgent: async (options) => {
          seen.push(options);
        },
      },
      models: {
        list: async () => [],
        efforts: async () => [],
        startArgs: async (...args) => {
          expect(args).toEqual([kind, model, "/project", "max"]);
          return ["fixture-args"];
        },
      },
    });
    const response = await postSplit(app, "w1:p1", { agent: kind, model, effort: "max" });
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        paneId: "w1:p2",
        kind,
        name: "hwc-w1-p2",
        args: [...(kind === "codex" ? ["--no-daemon"] : []), "fixture-args"],
      },
    ]);
  },
);

test("POST /api/panes/:id/split rejects effort without a model before creating anything", async () => {
  const { app } = createTestApp({
    panes: {
      split: async () => {
        throw new Error("Must not split");
      },
    },
  });
  expect((await postSplit(app, "w1:p1", { agent: "pi", effort: "high" })).status).toBe(400);
});

test.each(["claude", "unknown", ""])(
  "GET /api/panes/:id/models rejects unsupported agent %s",
  async (agent) => {
    const { app } = createTestApp();
    const response = await app.request(`/api/panes/w1:p1/models?agent=${agent}`);
    expect(response.status).toBe(400);
  },
);

test("GET /api/panes/:id/models identifies an OpenCode service that is not running", async () => {
  const { app } = createTestApp({
    models: {
      efforts: async () => [],
      list: async () => {
        throw new OpencodeServiceNotRunningError();
      },
      startArgs: async () => [],
    },
  });
  const response = await app.request("/api/panes/w1:p1/models?agent=opencode");
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "opencode_not_running" });
});

test.each(["pi", "opencode"])(
  "GET /api/panes/:id/models does not expose upstream %s errors or paths",
  async (agent) => {
    const { app } = createTestApp({
      models: {
        efforts: async () => [],
        list: async () => {
          throw new Error("/private/path: credential failure");
        },
        startArgs: async () => [],
      },
    });
    const response = await app.request(`/api/panes/w1:p1/models?agent=${agent}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "models_unavailable" });
  },
);

test("GET /api/panes/:id/models requires an existing pane and a readable snapshot", async () => {
  const missing = createTestApp().app;
  expect((await missing.request("/api/panes/w1:p9/models?agent=pi")).status).toBe(404);
  const unavailable = createTestApp({ state: null, storeFailure: new Error("unavailable") }).app;
  expect((await unavailable.request("/api/panes/w1:p1/models?agent=pi")).status).toBe(502);
});

test.each(["pi", "codex"] as const)(
  "POST /api/panes/:id/split passes the chosen %s model to startup preparation",
  async (kind) => {
    const seen: unknown[] = [];
    const model = { provider: "example", id: "beam" };
    const args = ["--model", kind === "pi" ? "example/beam" : "beam"];
    const { app } = createTestApp({
      panes: {
        split: async () => ({ paneId: "w1:p2" }),
        startAgent: async (options) => {
          seen.push(options);
        },
      },
      models: {
        efforts: async () => [],
        list: async () => [model],
        startArgs: async (agent, selected, directory) => {
          expect({ agent, selected, directory }).toEqual({
            agent: kind,
            selected: model,
            directory: "/project",
          });
          return args;
        },
      },
    });
    const response = await postSplit(app, "w1:p1", { agent: kind, model });
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        paneId: "w1:p2",
        kind,
        name: "hwc-w1-p2",
        args: kind === "codex" ? ["--no-daemon", ...args] : args,
      },
    ]);
  },
);

test("POST /api/panes/:id/split shows the chosen model until the session records one", async () => {
  const store = createFakeStore(twoChatPanesState);
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  let recorded: ChatSnapshot = emptyChat;
  const app = createApp({
    store,
    chat: createFakeChat({
      snapshot: async (path) => (path === otherSessionPath ? recorded : emptyChat),
    }),
    worktrees: createFakeWorktrees(),
    panes: createFakePanes({ split: async () => ({ paneId: "w1:p2" }) }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });

  const split = await postSplit(app, "w1:p1", {
    agent: "pi",
    model: { provider: "example", id: "beam" },
    effort: "low",
  });
  expect(split.status).toBe(200);

  const filled = await app.request("/api/panes/w1:p2/chat");
  expect(await filled.json()).toEqual({
    ...emptyChat,
    etag: "etag-1+launch",
    model: "beam",
    effort: "low",
  });

  // 最初のメッセージでセッションにモデルが載ったら、以降はセッションの値だけを出す。
  recorded = { ...emptyChat, etag: "etag-2", model: "beam-mini" };
  const fromSession = await app.request("/api/panes/w1:p2/chat");
  expect(await fromSession.json()).toEqual(recorded);
  recorded = emptyChat;
  const after = await app.request("/api/panes/w1:p2/chat");
  expect(await after.json()).toEqual(emptyChat);
});

test("a client that read the pane before the split is not pinned to the old snapshot", async () => {
  const { app, split } = launchModelApp();

  // 分割表示では、作成したペインの会話が split の応答より先に読まれることがある。
  const before = await app.request("/api/panes/w1:p2/chat");
  expect(await before.json()).toEqual(emptyChat);
  expect(before.headers.get("etag")).toBe(`"${emptyChat.etag}"`);

  expect((await split()).status).toBe(200);

  const after = await app.request("/api/panes/w1:p2/chat", {
    headers: { "if-none-match": `"${emptyChat.etag}"` },
  });
  expect(after.status).toBe(200);
  const filledEtag = "etag-1+launch";
  expect(await after.json()).toEqual({
    ...emptyChat,
    etag: filledEtag,
    model: "beam",
    effort: "low",
  });

  // 補完が続く間は同じ etag を返し、一致する If-None-Match に 304 を返す。
  const unchanged = await app.request("/api/panes/w1:p2/chat", {
    headers: { "if-none-match": `"${filledEtag}"` },
  });
  expect(unchanged.status).toBe(304);
});

test("POST /api/panes/:id/split shows the chosen model even when the rename fails", async () => {
  const store = createFakeStore(twoChatPanesState);
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  const app = createApp({
    store,
    chat: createFakeChat(),
    worktrees: createFakeWorktrees(),
    panes: createFakePanes({
      split: async () => ({ paneId: "w1:p2" }),
      rename: async () => {
        throw new HerdrError("pane_not_found", "no pane w1:p2");
      },
    }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });

  const split = await postSplit(app, "w1:p1", {
    name: "実装",
    agent: "pi",
    model: { provider: "example", id: "beam" },
  });
  expect(split.status).toBe(502);
  expect(await split.json()).toEqual({ error: "pane_rename_failed", paneId: "w1:p2" });

  const response = await app.request("/api/panes/w1:p2/chat");
  expect(await response.json()).toEqual({
    ...emptyChat,
    etag: "etag-1+launch",
    model: "beam",
    effort: null,
  });
});

test("POST /api/panes/:id/split does not show a model when the agent cannot start", async () => {
  const store = createFakeStore(twoChatPanesState);
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  const app = createApp({
    store,
    chat: createFakeChat(),
    worktrees: createFakeWorktrees(),
    panes: createFakePanes({
      split: async () => ({ paneId: "w1:p2" }),
      startAgent: async () => {
        throw new HerdrError("agent_spawn_failed", "pi is not installed");
      },
    }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });

  const split = await postSplit(app, "w1:p1", {
    agent: "pi",
    model: { provider: "example", id: "beam" },
  });
  expect(split.status).toBe(502);

  const response = await app.request("/api/panes/w1:p2/chat");
  expect(await response.json()).toEqual(emptyChat);
});

test("closing a pane drops the model chosen at startup", async () => {
  const { app, split } = launchModelApp();
  expect((await split()).status).toBe(200);

  const close = await app.request("/api/panes/w1:p2/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(close.status).toBe(200);

  const response = await app.request("/api/panes/w1:p2/chat");
  expect(await response.json()).toEqual(emptyChat);
});

test("POST /api/panes/:id/split rejects a Claude model override before creating anything", async () => {
  const { app } = createTestApp({
    panes: {
      split: async () => {
        throw new Error("Must not split");
      },
    },
  });
  const response = await postSplit(app, "w1:p1", {
    agent: "claude",
    model: { provider: "example", id: "beam" },
  });
  expect(response.status).toBe(400);
});

test("POST /api/panes/:id/split validates the body before loading a snapshot", async () => {
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("socket closed"),
  });
  const response = await postSplit(app, "w1:p1", { name: 42 });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "name must be a string" });
});

test("POST /api/panes/:id/split splits the largest cell toward the target aspect", async () => {
  const seenLayout: unknown[] = [];
  const seenSplit: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      layout: async (options) => {
        seenLayout.push(options);
        return {
          cells: [
            { paneId: "w1:p1", width: 100, height: 47 },
            { paneId: "w1:p2", width: 160, height: 47 },
          ],
        };
      },
      split: async (options) => {
        seenSplit.push(options);
        return { paneId: "w1:p3" };
      },
    },
  });
  const response = await postSplit(app, "w1:p1");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ paneId: "w1:p3" });
  expect(seenLayout).toEqual([{ paneId: "w1:p1" }]);
  // 一番大きいセルは w1:p2。160x47 は右に割ると 1.63 から 0.82 になり、下より目標 1.4 に近い。
  expect(seenSplit).toEqual([{ paneId: "w1:p2", direction: "right", ratio: 0.5 }]);
});

test("POST /api/panes/:id/split stops at four panes in the tab", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: fourPaneState,
    panes: {
      layout: async (options) => {
        seen.push(options);
        return { cells: [] };
      },
    },
  });
  const response = await postSplit(app, "w1:p1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "pane_limit" });
  expect(seen).toEqual([]);
});

test("POST /api/panes/:id/split stops when the layout already has four panes", async () => {
  const seenSplit: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      layout: async () => ({
        cells: [
          { paneId: "w1:p1", width: 60, height: 47 },
          { paneId: "w1:p2", width: 60, height: 47 },
          { paneId: "w1:p3", width: 60, height: 47 },
          { paneId: "w1:p4", width: 60, height: 47 },
        ],
      }),
      split: async (options) => {
        seenSplit.push(options);
        return { paneId: "w1:p5" };
      },
    },
  });
  const response = await postSplit(app, "w1:p1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "pane_limit" });
  expect(seenSplit).toEqual([]);
});

test("POST /api/panes/:id/split gives the creation the trimmed name and the agent", async () => {
  // 起動順や Herdr 名の作り方は create-pane.test.ts が見る。ここはルートが
  // parseSplitBody の結果を渡していることだけを見る。
  const seenStart: unknown[] = [];
  const seenRename: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      split: async () => ({ paneId: "w1:p3" }),
      startAgent: async (options) => {
        seenStart.push(options);
      },
      rename: async (options) => {
        seenRename.push(options);
      },
    },
  });
  const response = await postSplit(app, "w1:p1", { name: " 実装 ", agent: "pi" });

  expect(response.status).toBe(200);
  expect(seenStart).toMatchObject([{ paneId: "w1:p3", kind: "pi" }]);
  expect(seenRename).toEqual([{ paneId: "w1:p3", label: "実装" }]);
});

test("POST /api/panes/:id/split keeps the pane when the agent cannot start", async () => {
  const seenRename: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      split: async () => ({ paneId: "w1:p3" }),
      startAgent: async () => {
        throw new HerdrError("agent_spawn_failed", "codex is not installed");
      },
      rename: async (options) => {
        seenRename.push(options);
      },
    },
  });
  const response = await postSplit(app, "w1:p1", { name: "実装", agent: "codex" });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "agent_start_failed", paneId: "w1:p3" });
  // 起動に失敗しても、作成済みのペインには名前を付けておく。
  expect(seenRename).toEqual([{ paneId: "w1:p3", label: "実装" }]);
});

test("POST /api/panes/:id/split reports a rename failure after the pane is created", async () => {
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      split: async () => ({ paneId: "w1:p3" }),
      rename: async () => {
        throw new HerdrError("pane_not_found", "no pane w1:p3");
      },
    },
  });
  const response = await postSplit(app, "w1:p1", { name: "実装", agent: null });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "pane_rename_failed", paneId: "w1:p3" });
});

test("POST /api/panes/:id/split rejects a body without an object", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      split: async (options) => {
        seen.push(options);
        return { paneId: "w1:p2" };
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/split", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "body must be an object" });
  expect(seen).toEqual([]);
});

test("POST /api/panes/:id/split rejects an unknown agent or an overlong name", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      split: async (options) => {
        seen.push(options);
        return { paneId: "w1:p2" };
      },
    },
  });

  for (const body of [{ agent: "gemini" }, { name: 42 }, { name: "x".repeat(81) }]) {
    const response = await postSplit(app, "w1:p1", body);
    expect(response.status).toBe(400);
  }
  expect(seen).toEqual([]);
});
