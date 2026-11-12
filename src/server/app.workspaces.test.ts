import { expect, test } from "bun:test";
import { HerdrError } from "./herdr/socket";
import type { GitClient } from "./git";
import type { AppState } from "./herdr/state";
import {
  state,
  threeWorkspaces,
  checkoutPath,
  createFakeStore,
  createTestApp,
} from "./app.test-helpers";

const pullRequestState: AppState = {
  ...state,
  workspaces: [{ ...state.workspaces[0]!, branch: "feat/empty-state" }],
};

test("GET /api/workspaces/:id/pull-request returns the latest pull request of the branch", async () => {
  const calls: { checkoutPath: string; branch: string; refresh?: boolean }[] = [];
  const pullRequest = {
    number: 123,
    url: "https://github.com/example/acme/pull/123",
    title: "Add an empty state",
    state: "MERGED" as const,
  };
  const { app } = createTestApp({
    state: pullRequestState,
    pullRequests: async (options) => {
      calls.push(options);
      return pullRequest;
    },
  });

  const response = await app.request("/api/workspaces/w1/pull-request");

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ pullRequest });
  expect(calls).toEqual([{ checkoutPath, branch: "feat/empty-state", refresh: false }]);
});

test("GET /api/workspaces/:id/pull-request passes refresh through to the reader", async () => {
  const calls: { checkoutPath: string; branch: string; refresh?: boolean }[] = [];
  const { app } = createTestApp({
    state: pullRequestState,
    pullRequests: async (options) => {
      calls.push(options);
      return null;
    },
  });

  await app.request("/api/workspaces/w1/pull-request?refresh=1");
  await app.request("/api/workspaces/w1/pull-request?refresh=0");

  expect(calls).toEqual([
    { checkoutPath, branch: "feat/empty-state", refresh: true },
    { checkoutPath, branch: "feat/empty-state", refresh: false },
  ]);
});

test("GET /api/workspaces/:id/pull-request answers null when the workspace has no branch", async () => {
  let called = false;
  const { app } = createTestApp({
    pullRequests: async () => {
      called = true;
      return null;
    },
  });

  const response = await app.request("/api/workspaces/w1/pull-request");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ pullRequest: null });
  expect(called).toBe(false);
});

test("GET /api/workspaces/:id/pull-request answers null when gh cannot be read", async () => {
  const { app } = createTestApp({
    state: pullRequestState,
    pullRequests: async () => {
      throw new Error("gh is not installed");
    },
  });

  const response = await app.request("/api/workspaces/w1/pull-request");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ pullRequest: null });
});

test("GET /api/workspaces/:id/pull-request returns 404 for an unknown workspace", async () => {
  const { app } = createTestApp({ state: pullRequestState });
  const response = await app.request("/api/workspaces/w9/pull-request");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "workspace_not_found" });
});

test("GET /api/workspaces/:id/pull-request returns 502 when Herdr cannot be read", async () => {
  const { app } = createTestApp({ state: null, storeFailure: new Error("socket closed") });
  const response = await app.request("/api/workspaces/w1/pull-request");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

const syncState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      branch: "feat/empty-state",
      sync: {
        upstream: "origin/feat/empty-state",
        ahead: 1,
        behind: 2,
        hasRemote: true,
        repoUrl: "https://github.com/o/r",
      },
    },
  ],
};

function createFakeGit(overrides: Partial<GitClient> = {}): GitClient {
  return {
    read: async () => null,
    readRepo: async () => null,
    invalidate: () => {},
    fetch: async () => {},
    pull: async () => {},
    ...overrides,
  };
}

function postGit(action: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  };
}

test("POST /api/workspaces/:id/git fetches and republishes the state", async () => {
  const calls: string[] = [];
  const invalidated: string[] = [];
  let refreshes = 0;
  const store = createFakeStore(syncState);
  const refresh = store.refresh;
  store.refresh = async () => {
    refreshes += 1;
    return refresh();
  };
  store.invalidateGit = (workspaceId) => invalidated.push(workspaceId);
  const { app } = createTestApp({
    state: syncState,
    store,
    git: createFakeGit({
      fetch: async (path) => {
        calls.push(path);
      },
    }),
  });

  const response = await app.request("/api/workspaces/w1/git", postGit("fetch"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(calls).toEqual([checkoutPath]);
  expect(invalidated).toEqual(["w1"]);
  expect(refreshes).toBe(1);
});

test("POST /api/workspaces/:id/git pulls with fast-forward only", async () => {
  const calls: string[] = [];
  const { app } = createTestApp({
    state: syncState,
    git: createFakeGit({
      pull: async (path) => {
        calls.push(path);
      },
    }),
  });

  const response = await app.request("/api/workspaces/w1/git", postGit("pull"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(calls).toEqual([checkoutPath]);
});

test("POST /api/workspaces/:id/git refuses a fetch without a remote", async () => {
  let called = false;
  const stateWithoutRemote: AppState = {
    ...syncState,
    workspaces: [
      {
        ...syncState.workspaces[0]!,
        sync: {
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          repoUrl: null,
        },
      },
    ],
  };
  const { app } = createTestApp({
    state: stateWithoutRemote,
    git: createFakeGit({
      fetch: async () => {
        called = true;
      },
    }),
  });

  const response = await app.request("/api/workspaces/w1/git", postGit("fetch"));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "no_remote" });
  expect(called).toBe(false);
});

test("POST /api/workspaces/:id/git refuses a pull without an upstream", async () => {
  let called = false;
  const stateWithoutUpstream: AppState = {
    ...syncState,
    workspaces: [
      {
        ...syncState.workspaces[0]!,
        sync: {
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: true,
          repoUrl: "https://github.com/o/r",
        },
      },
    ],
  };
  const { app } = createTestApp({
    state: stateWithoutUpstream,
    git: createFakeGit({
      pull: async () => {
        called = true;
      },
    }),
  });

  const response = await app.request("/api/workspaces/w1/git", postGit("pull"));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "no_upstream" });
  expect(called).toBe(false);
});

test("POST /api/workspaces/:id/git requires a known action", async () => {
  const { app } = createTestApp({ state: syncState, git: createFakeGit() });
  const response = await app.request("/api/workspaces/w1/git", postGit("push"));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});

test("POST /api/workspaces/:id/git refuses a workspace without a checkout", async () => {
  const { app } = createTestApp({
    state: syncState,
    store: createFakeStore(syncState, undefined, null),
    git: createFakeGit(),
  });
  const response = await app.request("/api/workspaces/w1/git", postGit("fetch"));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_git_worktree" });
});

test("POST /api/workspaces/:id/git refuses a workspace without a branch", async () => {
  const { app } = createTestApp({ state, git: createFakeGit() });
  const response = await app.request("/api/workspaces/w1/git", postGit("fetch"));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_git_worktree" });
});

test("POST /api/workspaces/:id/git reports an unknown workspace", async () => {
  const { app } = createTestApp({ state: syncState, git: createFakeGit() });
  const response = await app.request("/api/workspaces/w9/git", postGit("fetch"));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "workspace_not_found" });
});

test("POST /api/workspaces/:id/git reports a git failure", async () => {
  const { app } = createTestApp({
    state: syncState,
    git: createFakeGit({
      fetch: async () => {
        throw new Error("git failed");
      },
    }),
  });
  const response = await app.request("/api/workspaces/w1/git", postGit("fetch"));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "git_fetch_failed" });
});

test("POST /api/workspaces/:id/git returns 502 when Herdr cannot be read", async () => {
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("socket closed"),
    git: createFakeGit(),
  });
  const response = await app.request("/api/workspaces/w1/git", postGit("fetch"));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

function postMove(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("POST /api/workspaces/move moves the block and republishes the state", async () => {
  const seen: unknown[] = [];
  const { app, store } = createTestApp({
    state: threeWorkspaces,
    workspaces: {
      moveBlock: async (options) => {
        seen.push(options);
      },
    },
  });

  const response = await app.request(
    "/api/workspaces/move",
    postMove({ workspaceIds: ["w3", "w2"], beforeWorkspaceId: "w1" }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ workspaceIds: ["w3", "w2"], beforeWorkspaceId: "w1" }]);
  expect(store.refreshCount()).toBe(1);
});

test("POST /api/workspaces/move moves the block to the end without an anchor", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: threeWorkspaces,
    workspaces: {
      moveBlock: async (options) => {
        seen.push(options);
      },
    },
  });

  const response = await app.request(
    "/api/workspaces/move",
    postMove({ workspaceIds: ["w1", "w2"], beforeWorkspaceId: null }),
  );

  expect(response.status).toBe(200);
  expect(seen).toEqual([{ workspaceIds: ["w1", "w2"], beforeWorkspaceId: null }]);
});

test("POST /api/workspaces/move validates the block before moving", async () => {
  for (const body of [
    {},
    { workspaceIds: [] },
    { workspaceIds: ["w1", "w1"] },
    { workspaceIds: ["w1"], beforeWorkspaceId: "w1" },
    { workspaceIds: ["w1"], beforeWorkspaceId: 1 },
  ]) {
    const { app } = createTestApp({ state: threeWorkspaces });
    const response = await app.request("/api/workspaces/move", postMove(body));
    expect(response.status).toBe(400);
  }
});

test("POST /api/workspaces/move requires application/json", async () => {
  const { app } = createTestApp({ state: threeWorkspaces });
  const response = await app.request("/api/workspaces/move", { method: "POST" });

  expect(response.status).toBe(415);
});

test("POST /api/workspaces/move refuses ids that are not in the state", async () => {
  let called = false;
  const { app } = createTestApp({
    state: threeWorkspaces,
    workspaces: {
      moveBlock: async () => {
        called = true;
      },
    },
  });

  const missing = await app.request("/api/workspaces/move", postMove({ workspaceIds: ["w9"] }));
  const anchor = await app.request(
    "/api/workspaces/move",
    postMove({ workspaceIds: ["w1"], beforeWorkspaceId: "w9" }),
  );

  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "workspace_not_found" });
  expect(anchor.status).toBe(404);
  expect(called).toBe(false);
});

test("POST /api/workspaces/move maps Herdr failures", async () => {
  const cases = [
    {
      error: new HerdrError("workspace_not_found", "w9"),
      status: 404,
      body: { error: "workspace_not_found" },
    },
    {
      error: new HerdrError("invalid_params", "block"),
      status: 400,
      body: { error: "invalid_request" },
    },
    {
      error: new HerdrError("herdr_internal", "boom"),
      status: 502,
      body: { error: "herdr_unavailable" },
    },
    { error: new Error("socket closed"), status: 502, body: { error: "herdr_unavailable" } },
  ];

  for (const item of cases) {
    const { app } = createTestApp({
      state: threeWorkspaces,
      workspaces: {
        moveBlock: async () => {
          throw item.error;
        },
      },
    });
    const response = await app.request(
      "/api/workspaces/move",
      postMove({ workspaceIds: ["w3"], beforeWorkspaceId: "w1" }),
    );

    expect(response.status).toBe(item.status);
    expect(await response.json()).toEqual(item.body);
  }
});

test("POST /api/workspaces/move returns 502 when Herdr cannot be read", async () => {
  const { app } = createTestApp({ state: null, storeFailure: new Error("socket closed") });
  const response = await app.request(
    "/api/workspaces/move",
    postMove({ workspaceIds: ["w3"], beforeWorkspaceId: null }),
  );

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});
