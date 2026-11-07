import { expect, mock, test } from "bun:test";
import { createWorktree } from "./create-worktree";
import type { AgentStartOptions, RenameOptions } from "./herdr/panes";
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
    directory: mock(async (_options: { paneId: string }) => {
      calls.push("directory");
      return "/worktrees/hwc-api";
    }),
    startAgent: mock(async (_options: AgentStartOptions) => {
      calls.push("start");
    }),
    rename: mock(async (_options: RenameOptions) => {
      calls.push("rename");
    }),
  };
  return { worktrees, panes, calls };
}

test("creates the worktree before starting the agent in its root pane", async () => {
  const { worktrees, panes, calls } = createFakeClients();
  const result = await createWorktree(worktrees, panes, "w1", { name: "実装", agent: "pi" });

  expect(result).toEqual({ ok: true, workspaceId: "w2", paneId: "w2:p1" });
  expect(calls).toEqual(["create", "start", "rename"]);
  expect(worktrees.create).toHaveBeenCalledWith({ workspaceId: "w1" });
  // root pane は Herdr が作るので分割しない。エージェント名はペイン id から作る。
  expect(panes.startAgent).toHaveBeenCalledWith({
    paneId: "w2:p1",
    kind: "pi",
    name: "hwc-w2-p1",
  });
  expect(panes.rename).toHaveBeenCalledWith({ paneId: "w2:p1", label: "実装" });
});

test("an unnamed shell worktree needs only the creation", async () => {
  const { worktrees, panes, calls } = createFakeClients();
  const result = await createWorktree(worktrees, panes, "w1", { name: null, agent: null });

  expect(result).toEqual({ ok: true, workspaceId: "w2", paneId: "w2:p1" });
  expect(calls).toEqual(["create"]);
  expect(panes.directory).not.toHaveBeenCalled();
});

test.each(["pi", "codex", "opencode"] as const)(
  "a %s worktree pane verifies the model in the new root pane's directory",
  async (agent) => {
    const { worktrees, panes } = createFakeClients();
    const model = { provider: "example", id: "beam" };
    const seen: unknown[] = [];
    const models = {
      list: mock(async () => [model]),
      efforts: mock(async () => []),
      startArgs: mock(async (...args: unknown[]) => {
        seen.push(args);
        return ["--model", agent === "codex" ? "beam" : "example/beam"];
      }),
    };

    const result = await createWorktree(
      worktrees,
      panes,
      "w1",
      { name: null, agent, model, effort: "high" },
      models,
    );

    expect(result).toEqual({ ok: true, workspaceId: "w2", paneId: "w2:p1" });
    // 候補の取得元は起点スペースでも、起動時の検証は新しい worktree の cwd で行う。
    expect(panes.directory).toHaveBeenCalledWith({ paneId: "w2:p1" });
    expect(seen).toEqual([[agent, model, "/worktrees/hwc-api", "high"]]);
    expect(panes.startAgent).toHaveBeenCalledWith({
      paneId: "w2:p1",
      kind: agent,
      name: "hwc-w2-p1",
      args: [
        ...(agent === "codex" ? ["--no-daemon"] : []),
        "--model",
        agent === "codex" ? "beam" : "example/beam",
      ],
    });
  },
);

test("an unavailable model keeps the worktree and its shell without falling back", async () => {
  const { worktrees, panes } = createFakeClients();
  const models = {
    list: async () => [],
    efforts: async () => [],
    startArgs: async () => {
      throw new Error("unavailable");
    },
  };

  expect(
    await createWorktree(
      worktrees,
      panes,
      "w1",
      { name: "実装", agent: "pi", model: { provider: "example", id: "beam" } },
      models,
    ),
  ).toEqual({ ok: false, error: "agent_start_failed", workspaceId: "w2", paneId: "w2:p1" });
  expect(panes.startAgent).not.toHaveBeenCalled();
  expect(panes.rename).toHaveBeenCalledWith({ paneId: "w2:p1", label: "実装" });
});

test("an agent waiting at its startup prompt still reports the new pane", async () => {
  const { worktrees, panes } = createFakeClients();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_not_ready", "waiting for trust"));

  expect(await createWorktree(worktrees, panes, "w1", { name: null, agent: "claude" })).toEqual({
    ok: true,
    workspaceId: "w2",
    paneId: "w2:p1",
  });
});

test("a failed agent start keeps the worktree and reports the partial success", async () => {
  const { worktrees, panes } = createFakeClients();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_spawn_failed", "cannot start"));

  expect(await createWorktree(worktrees, panes, "w1", { name: "実装", agent: "codex" })).toEqual({
    ok: false,
    error: "agent_start_failed",
    workspaceId: "w2",
    paneId: "w2:p1",
  });
  expect(panes.rename).toHaveBeenCalledWith({ paneId: "w2:p1", label: "実装" });
});

test("a failed rename reports the new pane without creating a second worktree", async () => {
  const { worktrees, panes } = createFakeClients();
  panes.rename.mockRejectedValue(new Error("socket closed"));

  expect(await createWorktree(worktrees, panes, "w1", { name: "実装", agent: "pi" })).toEqual({
    ok: false,
    error: "pane_rename_failed",
    workspaceId: "w2",
    paneId: "w2:p1",
  });
  expect(worktrees.create).toHaveBeenCalledTimes(1);
});

test("a creation failure is propagated before starting or renaming anything", async () => {
  const { worktrees, panes } = createFakeClients();
  const failure = new HerdrError("worktree_create_failed", "git worktree add failed");
  worktrees.create.mockRejectedValue(failure);

  await expect(createWorktree(worktrees, panes, "w1", { name: "実装", agent: "pi" })).rejects.toBe(
    failure,
  );
  expect(panes.startAgent).not.toHaveBeenCalled();
  expect(panes.rename).not.toHaveBeenCalled();
});
