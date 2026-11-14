import { expect, mock, test } from "bun:test";
import { createWorktree } from "./create-worktree";
import type { RenameOptions } from "./herdr/panes";
import { HerdrError } from "./herdr/socket";

function createFakeClients() {
  const calls: string[] = [];
  const worktrees = {
    create: mock(async (_options: { workspaceId: string }) => {
      calls.push("create");
      return { workspaceId: "w2", paneId: "w2:p1" };
    }),
  };
  const panes = {
    rename: mock(async (_options: RenameOptions) => {
      calls.push("rename");
    }),
  };
  return { worktrees, panes, calls };
}

test("creates the worktree and applies the name to its root pane", async () => {
  const { worktrees, panes, calls } = createFakeClients();
  const result = await createWorktree(worktrees, panes, "w1", { name: "実装" });

  expect(result).toEqual({ ok: true, workspaceId: "w2", paneId: "w2:p1" });
  expect(calls).toEqual(["create", "rename"]);
  expect(worktrees.create).toHaveBeenCalledWith({ workspaceId: "w1" });
  // root pane は Herdr が作るので分割しない。起動はクライアントが後から頼む。
  expect(panes.rename).toHaveBeenCalledWith({ paneId: "w2:p1", label: "実装" });
});

test("an unnamed worktree needs only the creation", async () => {
  const { worktrees, panes, calls } = createFakeClients();
  const result = await createWorktree(worktrees, panes, "w1", { name: null });

  expect(result).toEqual({ ok: true, workspaceId: "w2", paneId: "w2:p1" });
  expect(calls).toEqual(["create"]);
  expect(panes.rename).not.toHaveBeenCalled();
});

test("a failed rename reports the new pane without creating a second worktree", async () => {
  const { worktrees, panes } = createFakeClients();
  panes.rename.mockRejectedValue(new Error("socket closed"));

  expect(await createWorktree(worktrees, panes, "w1", { name: "実装" })).toEqual({
    ok: false,
    error: "pane_rename_failed",
    workspaceId: "w2",
    paneId: "w2:p1",
  });
  expect(worktrees.create).toHaveBeenCalledTimes(1);
});

test("a creation failure is propagated before renaming anything", async () => {
  const { worktrees, panes } = createFakeClients();
  const failure = new HerdrError("worktree_create_failed", "git worktree add failed");
  worktrees.create.mockRejectedValue(failure);

  await expect(createWorktree(worktrees, panes, "w1", { name: "実装" })).rejects.toBe(failure);
  expect(panes.rename).not.toHaveBeenCalled();
});
