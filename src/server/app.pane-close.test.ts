import { expect, test } from "bun:test";
import { HerdrError } from "./herdr/socket";
import {
  state,
  workingState,
  chatPane,
  chatState,
  twoChatPanesState,
  createFakeStore,
  createTestApp,
} from "./app.test-helpers";

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
        store.push(
          {
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
          },
          true,
        );
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

test("exit clears the old agent screen after the pane is back to a shell", async () => {
  const store = createFakeStore(chatState);
  const cleared: string[] = [];
  const { app } = createTestApp({
    store,
    panes: {
      exit: async () => {},
      clear: async ({ paneId }) => {
        cleared.push(paneId);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/exit", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(200);
  expect(cleared).toEqual([]);

  store.push(
    {
      ...chatState,
      workspaces: [
        {
          ...chatState.workspaces[0]!,
          tabs: [
            {
              ...chatState.workspaces[0]!.tabs[0]!,
              panes: [{ ...chatPane, agent: null, chat: false }],
            },
          ],
        },
      ],
    },
    true,
  );
  expect(cleared).toEqual(["w1:p1"]);
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
