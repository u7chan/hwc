import { expect, test } from "bun:test";
import { createWorktreeClient } from "./worktrees";
import { HerdrError } from "./socket";

type Call = { method: string; params: unknown; options: unknown };

function recordingCaller(replies: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const call = async <T>(method: string, params?: unknown, options?: unknown): Promise<T> => {
    calls.push({ method, params, options });
    if (!(method in replies)) return {} as T;
    const reply = replies[method];
    if (reply instanceof Error) throw reply;
    return reply as T;
  };
  return { calls, call };
}

test("remove asks Herdr to delete the checkout with force", async () => {
  const { calls, call } = recordingCaller({
    "worktree.remove": { type: "worktree_removed", workspace_id: "w2", forced: true },
  });
  const client = createWorktreeClient({ path: "/tmp/test.sock", call });

  await client.remove({ workspaceId: "w2" });

  expect(calls).toEqual([
    {
      method: "worktree.remove",
      params: { workspace_id: "w2", force: true },
      options: { path: "/tmp/test.sock", timeoutMs: 60_000 },
    },
  ]);
});

test("remove propagates the Herdr error so the caller can map it", async () => {
  const error = new Error("worktree_remove_failed");
  const { call } = recordingCaller({ "worktree.remove": error });
  const client = createWorktreeClient({ call });

  await expect(client.remove({ workspaceId: "w2" })).rejects.toBe(error);
});

test("create asks Herdr to open a new checkout in the source workspace", async () => {
  const { calls, call } = recordingCaller({
    "worktree.create": {
      type: "worktree_created",
      workspace: { workspace_id: "w2", label: "hwc worktree/api" },
      tab: { tab_id: "w2:t1" },
      root_pane: { pane_id: "w2:p1" },
      worktree: { repo_name: "hwc", is_linked_worktree: true },
    },
  });
  const client = createWorktreeClient({ path: "/tmp/test.sock", call });

  expect(await client.create({ workspaceId: "w1" })).toEqual({
    workspaceId: "w2",
    paneId: "w2:p1",
  });
  // ブランチ名と保存先は Herdr に任せる。focus だけを明示する。
  expect(calls).toEqual([
    {
      method: "worktree.create",
      params: { workspace_id: "w1", focus: true },
      options: { path: "/tmp/test.sock", timeoutMs: 60_000 },
    },
  ]);
});

test("create rejects a response without the new workspace and root pane", async () => {
  const { call } = recordingCaller({
    "worktree.create": { type: "worktree_created", workspace: { workspace_id: "w2" } },
  });
  const client = createWorktreeClient({ call });

  await expect(client.create({ workspaceId: "w1" })).rejects.toThrow(/root_pane/);
});

test("create propagates the Herdr error so the caller can map it", async () => {
  const error = new HerdrError("worktree_create_failed", "git worktree add failed");
  const { call } = recordingCaller({ "worktree.create": error });
  const client = createWorktreeClient({ call });

  await expect(client.create({ workspaceId: "w1" })).rejects.toBe(error);
});
