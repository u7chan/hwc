import { expect, test } from "bun:test";
import { createWorktreeClient } from "./worktrees";

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
