import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";
import { HerdrError } from "./herdr/socket";
import type { WorkspaceClient } from "./herdr/workspaces";
import type { PaneClient } from "./herdr/panes";
import { createFakeStore, createTestApp, state, withCheckout } from "./app.test-helpers";

function createSpaceApp(
  root: string | null,
  options: { workspaces?: Partial<WorkspaceClient>; panes?: Partial<PaneClient> } = {},
) {
  // シェルのペイン（会話なし）から作る。ツリーと同じく、チャットの有無を問わない。
  const store = createFakeStore(state);
  return createTestApp({
    store: { ...store, workspaceRoot: () => root },
    workspaces: options.workspaces,
    panes: options.panes,
  }).app;
}

function postCreateSpace(app: ReturnType<typeof createApp>, body: unknown, paneId = "w1:p1") {
  return app.request(`/api/panes/${paneId}/create-space`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/panes/:id/create-space opens a space on the chosen folder and names its root pane", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, "packages", "web"), { recursive: true });
    const created: unknown[] = [];
    const renamed: unknown[] = [];
    const app = createSpaceApp(root, {
      workspaces: {
        create: async (options) => {
          created.push(options);
          return { workspaceId: "w2", paneId: "w2:p1" };
        },
      },
      panes: {
        startAgent: async () => {
          throw new Error("Must not start the agent in the creation request");
        },
        rename: async (options) => {
          renamed.push(options);
        },
      },
    });

    const response = await postCreateSpace(app, { path: "packages/web", name: " 実装 " });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: "w2", paneId: "w2:p1" });
    // cwd は実体の絶対パス、スペース名はフォルダ名。
    expect(created).toEqual([{ cwd: join(root, "packages", "web"), label: "web" }]);
    expect(renamed).toEqual([{ paneId: "w2:p1", label: "実装" }]);
  });
});

test("create-space leaves the root pane unnamed without a name", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, "api"));
    const app = createSpaceApp(root, {
      workspaces: { create: async () => ({ workspaceId: "w2", paneId: "w2:p1" }) },
      panes: {
        rename: async () => {
          throw new Error("Must not rename");
        },
      },
    });

    const response = await postCreateSpace(app, { path: "api" });
    expect(response.status).toBe(200);
  });
});

test("create-space reports a rename failure with the space it created", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, "api"));
    const app = createSpaceApp(root, {
      workspaces: { create: async () => ({ workspaceId: "w2", paneId: "w2:p1" }) },
      panes: {
        rename: async () => {
          throw new HerdrError("pane_not_found", "gone");
        },
      },
    });

    const response = await postCreateSpace(app, { path: "api", name: "実装" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "pane_rename_failed",
      workspaceId: "w2",
      paneId: "w2:p1",
    });
  });
});

test("create-space rejects a path that is not a relative folder path", async () => {
  await withCheckout(async (root) => {
    const app = createSpaceApp(root);
    for (const body of [
      {},
      { path: "" },
      { path: "/etc" },
      { path: "../outside" },
      { path: "a//b" },
      { path: "./a" },
      { path: 1 },
      { path: "a", name: 1 },
    ]) {
      const response = await postCreateSpace(app, body);
      expect(response.status).toBe(400);
    }
  });
});

test("create-space only opens folders inside the checkout outside .git", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, ".git", "hooks"), { recursive: true });
    await writeFile(join(root, "note.md"), "text");
    await symlink("/", join(root, "escape"));
    const app = createSpaceApp(root);

    for (const path of ["missing", "note.md", ".git/hooks", "escape"]) {
      const response = await postCreateSpace(app, { path });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });
});

test("create-space needs the pane and its checkout", async () => {
  await withCheckout(async (root) => {
    const missing = await postCreateSpace(createSpaceApp(root), { path: "a" }, "w9:p9");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "pane_not_found" });
  });

  const noRoot = await postCreateSpace(createSpaceApp(null), { path: "a" });
  expect(noRoot.status).toBe(404);
  expect(await noRoot.json()).toEqual({ error: "no_checkout" });
});

test("create-space maps Herdr failures without inviting a resend", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, "api"));
    const failing = (error: unknown) =>
      createSpaceApp(root, {
        workspaces: {
          create: async () => {
            throw error;
          },
        },
      });

    const invalid = await postCreateSpace(failing(new HerdrError("invalid_params", "bad")), {
      path: "api",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_request" });

    // 期限切れ・切断は作成できたか分からない。
    const unknown = await postCreateSpace(failing(new Error("socket timeout")), { path: "api" });
    expect(unknown.status).toBe(502);
    expect(await unknown.json()).toEqual({ error: "herdr_unavailable" });
  });
});
