import { expect, mock, test } from "bun:test";
import { createPane, startAgentInPane } from "./create-pane";
import type { AgentStartOptions, LayoutOptions, RenameOptions, SplitOptions } from "./herdr/panes";
import { HerdrError } from "./herdr/socket";

function createFakePanes() {
  const calls: string[] = [];
  const panes = {
    directory: mock(async (_options: { paneId: string }) => "/project"),
    layout: mock(async (_options: LayoutOptions) => {
      calls.push("layout");
      return {
        cells: [
          { paneId: "w1:p1", width: 100, height: 47 },
          { paneId: "w1:p2", width: 160, height: 47 },
        ],
      };
    }),
    split: mock(async (_options: SplitOptions) => {
      calls.push("split");
      return { paneId: "w1:p3" };
    }),
    startAgent: mock(async (_options: AgentStartOptions) => {
      calls.push("start");
    }),
    rename: mock(async (_options: RenameOptions) => {
      calls.push("rename");
    }),
  };
  return { panes, calls };
}

test("creates the pane before starting the agent and applying its display name", async () => {
  const { panes, calls } = createFakePanes();
  const result = await createPane(panes, "w1:p1", { name: "実装", agent: "pi" });

  expect(result).toEqual({ ok: true, paneId: "w1:p3" });
  expect(calls).toEqual(["layout", "split", "start", "rename"]);
  expect(panes.layout).toHaveBeenCalledWith({ paneId: "w1:p1" });
  expect(panes.split).toHaveBeenCalledWith({ paneId: "w1:p2", direction: "right", ratio: 0.5 });
  expect(panes.startAgent).toHaveBeenCalledWith({
    paneId: "w1:p3",
    kind: "pi",
    name: "hwc-w1-p3",
  });
  expect(panes.rename).toHaveBeenCalledWith({ paneId: "w1:p3", label: "実装" });
});

test("an unnamed shell needs only the layout and split requests", async () => {
  const { panes, calls } = createFakePanes();
  const result = await createPane(panes, "w1:p1", { name: null, agent: null });

  expect(result).toEqual({ ok: true, paneId: "w1:p3" });
  expect(calls).toEqual(["layout", "split"]);
  expect(panes.directory).not.toHaveBeenCalled();
});

test.each(["pi", "claude", "codex", "opencode"] as const)(
  "%s with no model override starts with its own CLI default",
  async (agent) => {
    const { panes } = createFakePanes();
    const models = {
      list: mock(async () => []),
      efforts: mock(async () => []),
      startArgs: mock(async () => []),
    };
    expect(await createPane(panes, "w1:p1", { name: null, agent, model: null }, models)).toEqual({
      ok: true,
      paneId: "w1:p3",
    });
    expect(panes.startAgent).toHaveBeenCalledWith({
      paneId: "w1:p3",
      kind: agent,
      name: "hwc-w1-p3",
      ...(agent === "codex" ? { args: ["--no-daemon"] } : {}),
    });
    expect(panes.directory).not.toHaveBeenCalled();
    expect(models.list).not.toHaveBeenCalled();
    expect(models.efforts).not.toHaveBeenCalled();
    expect(models.startArgs).not.toHaveBeenCalled();
  },
);

test.each(["pi", "claude", "codex", "opencode"] as const)(
  "a new %s pane starts with model-specific arguments",
  async (agent) => {
    const { panes } = createFakePanes();
    const model = { provider: "example", id: "beam" };
    const models = {
      list: mock(async () => [model]),
      efforts: mock(async () => []),
      startArgs: mock(async () => ["--model", agent === "codex" ? "beam" : "example/beam"]),
    };
    const result = await createPane(panes, "w1:p1", { name: "実装", agent, model }, models);
    expect(result).toEqual({ ok: true, paneId: "w1:p3" });
    expect(panes.directory).toHaveBeenCalledWith({ paneId: "w1:p3" });
    expect(models.startArgs).toHaveBeenCalledWith(agent, model, "/project", null);
    expect(panes.startAgent).toHaveBeenCalledWith({
      paneId: "w1:p3",
      kind: agent,
      name: "hwc-w1-p3",
      args: [
        ...(agent === "codex" ? ["--no-daemon"] : []),
        "--model",
        agent === "codex" ? "beam" : "example/beam",
      ],
    });
  },
);

test.each(["pi", "claude", "codex", "opencode"] as const)(
  "a %s model or effort preparation failure keeps the named shell without falling back",
  async (agent) => {
    const { panes } = createFakePanes();
    const models = {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => {
        throw new Error("unavailable");
      },
    };
    expect(
      await createPane(
        panes,
        "w1:p1",
        {
          name: "実装",
          agent,
          model: { provider: "example", id: "beam" },
          effort: "high",
        },
        models,
      ),
    ).toEqual({ ok: false, error: "agent_start_failed", paneId: "w1:p3" });
    expect(panes.startAgent).not.toHaveBeenCalled();
    expect(panes.rename).toHaveBeenCalledWith({ paneId: "w1:p3", label: "実装" });
  },
);

test("a named shell is renamed without starting an agent", async () => {
  const { panes, calls } = createFakePanes();
  const result = await createPane(panes, "w1:p1", { name: "ログ", agent: null });

  expect(result).toEqual({ ok: true, paneId: "w1:p3" });
  expect(calls).toEqual(["layout", "split", "rename"]);
  expect(panes.rename).toHaveBeenCalledWith({ paneId: "w1:p3", label: "ログ" });
});

test.each([0, 4])("a layout with %i cells cannot create another pane", async (count) => {
  const { panes } = createFakePanes();
  panes.layout.mockResolvedValue({
    cells: Array.from({ length: count }, (_, index) => ({
      paneId: `w1:p${index + 1}`,
      width: 60,
      height: 47,
    })),
  });

  expect(await createPane(panes, "w1:p1", { name: "実装", agent: "pi" })).toEqual({
    ok: false,
    error: "pane_limit",
  });
  expect(panes.split).not.toHaveBeenCalled();
  expect(panes.startAgent).not.toHaveBeenCalled();
  expect(panes.rename).not.toHaveBeenCalled();
});

test.each(["layout", "split"] as const)(
  "a %s failure is propagated before starting or renaming anything",
  async (operation) => {
    const { panes } = createFakePanes();
    const failure = new HerdrError("pane_not_found", "pane is gone");
    panes[operation].mockRejectedValue(failure);

    await expect(createPane(panes, "w1:p1", { name: "実装", agent: "pi" })).rejects.toBe(failure);
    if (operation === "layout") expect(panes.split).not.toHaveBeenCalled();
    expect(panes.startAgent).not.toHaveBeenCalled();
    expect(panes.rename).not.toHaveBeenCalled();
  },
);

test("an agent waiting at its startup prompt is still a successful creation", async () => {
  const { panes } = createFakePanes();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_not_ready", "waiting for trust"));

  expect(await createPane(panes, "w1:p1", { name: "実装", agent: "claude" })).toEqual({
    ok: true,
    paneId: "w1:p3",
  });
  expect(panes.rename).toHaveBeenCalledTimes(1);
});

test.each([null, "実装"])(
  "a failed agent keeps the new pane and its requested name %s",
  async (name) => {
    const { panes } = createFakePanes();
    panes.startAgent.mockRejectedValue(new HerdrError("agent_spawn_failed", "cannot start"));

    expect(await createPane(panes, "w1:p1", { name, agent: "codex" })).toEqual({
      ok: false,
      error: "agent_start_failed",
      paneId: "w1:p3",
    });
    expect(panes.split).toHaveBeenCalledTimes(1);
    expect(panes.startAgent).toHaveBeenCalledTimes(1);
    if (name === null) expect(panes.rename).not.toHaveBeenCalled();
    else expect(panes.rename).toHaveBeenCalledWith({ paneId: "w1:p3", label: name });
  },
);

test("a rename failure reports the new pane without retrying the creation", async () => {
  const { panes } = createFakePanes();
  panes.rename.mockRejectedValue(new Error("socket closed"));

  expect(await createPane(panes, "w1:p1", { name: "実装", agent: "pi" })).toEqual({
    ok: false,
    error: "pane_rename_failed",
    paneId: "w1:p3",
  });
  expect(panes.split).toHaveBeenCalledTimes(1);
  expect(panes.startAgent).toHaveBeenCalledTimes(1);
  expect(panes.rename).toHaveBeenCalledTimes(1);
});

test("a failed rename does not hide the agent startup failure", async () => {
  const { panes } = createFakePanes();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_spawn_failed", "cannot start"));
  panes.rename.mockRejectedValue(new Error("socket closed"));

  expect(await createPane(panes, "w1:p1", { name: "実装", agent: "codex" })).toEqual({
    ok: false,
    error: "agent_start_failed",
    paneId: "w1:p3",
  });
  expect(panes.rename).toHaveBeenCalledTimes(1);
});

test("starts an agent in an existing shell pane without splitting or renaming", async () => {
  const { panes, calls } = createFakePanes();

  expect(
    await startAgentInPane(panes, "w1:p1", {
      agent: "pi",
      model: null,
      effort: null,
      waitForShell: false,
    }),
  ).toBeNull();
  expect(calls).toEqual(["start"]);
  // 名前は同じペインで起動し直しても重ならないよう、起動のたびに接尾辞が変わる。
  expect(panes.startAgent).toHaveBeenCalledWith({
    paneId: "w1:p1",
    kind: "pi",
    name: expect.stringMatching(/^hwc-w1-p1-[0-9a-z]{4}$/),
    waitForShell: false,
  });
  expect(panes.rename).not.toHaveBeenCalled();
});

test("a fresh split waits for the shell before starting the agent", async () => {
  const { panes } = createFakePanes();

  expect(
    await startAgentInPane(panes, "w1:p2", {
      agent: "pi",
      model: null,
      effort: null,
      waitForShell: true,
    }),
  ).toBeNull();
  // 待つのは Herdr 側の既定。明示の false を渡さない。
  expect(panes.startAgent).toHaveBeenCalledWith({
    paneId: "w1:p2",
    kind: "pi",
    name: expect.stringMatching(/^hwc-w1-p2-[0-9a-z]{4}$/),
  });
});

test("a fresh split reports a shell that never became ready as a failed start", async () => {
  const { panes } = createFakePanes();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_pane_busy", "shell is not ready"));

  expect(
    await startAgentInPane(panes, "w1:p2", {
      agent: "pi",
      model: null,
      effort: null,
      waitForShell: true,
    }),
  ).toBe("agent_start_failed");
  expect(panes.startAgent).toHaveBeenCalledTimes(1);
});

test("an existing shell takes the selected model arguments for the pane's directory", async () => {
  const { panes } = createFakePanes();
  const model = { provider: "example", id: "beam" };
  const models = {
    list: mock(async () => [model]),
    efforts: mock(async () => []),
    startArgs: mock(async () => ["--model", "beam"]),
  };

  expect(
    await startAgentInPane(
      panes,
      "w1:p1",
      { agent: "codex", model, effort: "low", waitForShell: false },
      models,
    ),
  ).toBeNull();
  expect(panes.directory).toHaveBeenCalledWith({ paneId: "w1:p1" });
  expect(models.startArgs).toHaveBeenCalledWith("codex", model, "/project", "low");
  expect(panes.startAgent).toHaveBeenCalledWith({
    paneId: "w1:p1",
    kind: "codex",
    name: expect.stringMatching(/^hwc-w1-p1-[0-9a-z]{4}$/),
    waitForShell: false,
    args: ["--no-daemon", "--model", "beam"],
  });
});

test("an existing shell keeps the pane when the agent waits at its startup prompt", async () => {
  const { panes } = createFakePanes();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_not_ready", "waiting for trust"));

  expect(
    await startAgentInPane(panes, "w1:p1", {
      agent: "claude",
      model: null,
      effort: null,
      waitForShell: false,
    }),
  ).toBeNull();
});

test("a failed start on an existing shell reports the failure without retrying", async () => {
  const { panes } = createFakePanes();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_spawn_failed", "cannot start"));

  expect(
    await startAgentInPane(panes, "w1:p1", {
      agent: "pi",
      model: null,
      effort: null,
      waitForShell: false,
    }),
  ).toBe("agent_start_failed");
  expect(panes.startAgent).toHaveBeenCalledTimes(1);
});

function createFakeDefaults() {
  const calls: string[] = [];
  return {
    calls,
    defaults: {
      remember: (paneId: string) => calls.push(`remember ${paneId}`),
      forget: (paneId: string) => calls.push(`forget ${paneId}`),
    },
  };
}

test("a pi launch with no model is remembered before the agent can appear", async () => {
  const { panes, calls } = createFakePanes();
  const defaults = createFakeDefaults();

  await createPane(panes, "w1:p1", { name: "実装", agent: "pi" }, undefined, defaults.defaults);

  // 起動後に置くと、名前の付け直しを待つ間の最初の会話取得が預かりより先に届く。
  expect(defaults.calls).toEqual(["remember w1:p3"]);
  expect(calls).toEqual(["layout", "split", "start", "rename"]);
});

test("only pi launches without a model are remembered", async () => {
  const { panes } = createFakePanes();
  const explicit = createFakeDefaults();
  const models = {
    list: async () => [],
    efforts: async () => [],
    startArgs: async () => ["--model", "example/beam"],
  };

  await createPane(
    panes,
    "w1:p1",
    { name: null, agent: "pi", model: { provider: "example", id: "beam" }, effort: null },
    models,
    explicit.defaults,
  );
  const codex = createFakeDefaults();
  await createPane(
    panes,
    "w1:p1",
    { name: null, agent: "codex", model: null },
    undefined,
    codex.defaults,
  );

  expect(explicit.calls).toEqual([]);
  expect(codex.calls).toEqual([]);
});

test("a failed start drops the remembered default before the shell remains", async () => {
  const { panes } = createFakePanes();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_spawn_failed", "cannot start"));
  const defaults = createFakeDefaults();

  expect(
    await createPane(panes, "w1:p1", { name: null, agent: "pi" }, undefined, defaults.defaults),
  ).toEqual({ ok: false, error: "agent_start_failed", paneId: "w1:p3" });
  expect(defaults.calls).toEqual(["remember w1:p3", "forget w1:p3"]);
});

test("an agent waiting at its startup prompt keeps the remembered default", async () => {
  const { panes } = createFakePanes();
  panes.startAgent.mockRejectedValue(new HerdrError("agent_not_ready", "waiting for trust"));
  const defaults = createFakeDefaults();

  expect(
    await createPane(panes, "w1:p1", { name: null, agent: "pi" }, undefined, defaults.defaults),
  ).toEqual({ ok: true, paneId: "w1:p3" });
  expect(defaults.calls).toEqual(["remember w1:p3"]);
});
