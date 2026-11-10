import { expect, test } from "bun:test";
import { createWorkspaceClient, parseMoveWorkspacesBody } from "./workspaces";

type Call = { method: string; params: unknown; options: unknown };

function recordingCaller() {
  const calls: Call[] = [];
  const call = async <T>(method: string, params?: unknown, options?: unknown): Promise<T> => {
    calls.push({ method, params, options });
    return { type: "workspace_list" } as T;
  };
  return { calls, call };
}

test("parseMoveWorkspacesBody accepts a block with an anchor", () => {
  expect(parseMoveWorkspacesBody({ workspaceIds: ["w3", "w2"], beforeWorkspaceId: "w1" })).toEqual({
    ok: true,
    value: { workspaceIds: ["w3", "w2"], beforeWorkspaceId: "w1" },
  });
});

test("parseMoveWorkspacesBody treats a missing anchor as the end", () => {
  expect(parseMoveWorkspacesBody({ workspaceIds: ["w3"] })).toEqual({
    ok: true,
    value: { workspaceIds: ["w3"], beforeWorkspaceId: null },
  });
  expect(parseMoveWorkspacesBody({ workspaceIds: ["w3"], beforeWorkspaceId: null })).toEqual({
    ok: true,
    value: { workspaceIds: ["w3"], beforeWorkspaceId: null },
  });
});

test("parseMoveWorkspacesBody rejects a body that cannot name a block", () => {
  for (const body of [
    null,
    [],
    {},
    { workspaceIds: [] },
    { workspaceIds: "w1" },
    { workspaceIds: ["w1", ""] },
    { workspaceIds: ["w1", "w1"] },
    { workspaceIds: ["w1"], beforeWorkspaceId: 1 },
    { workspaceIds: ["w1"], beforeWorkspaceId: "" },
    { workspaceIds: ["w1", "w2"], beforeWorkspaceId: "w2" },
  ]) {
    expect(parseMoveWorkspacesBody(body).ok).toBe(false);
  }
});

test("moveBlock sends the whole block and the anchor to Herdr", async () => {
  const { calls, call } = recordingCaller();
  const client = createWorkspaceClient({ path: "/tmp/test.sock", call });

  await client.moveBlock({ workspaceIds: ["w3", "w2"], beforeWorkspaceId: "w1" });
  await client.moveBlock({ workspaceIds: ["w3"], beforeWorkspaceId: null });

  expect(calls).toEqual([
    {
      method: "workspace.move_block",
      params: { workspace_ids: ["w3", "w2"], before_workspace_id: "w1" },
      options: { path: "/tmp/test.sock" },
    },
    {
      method: "workspace.move_block",
      params: { workspace_ids: ["w3"], before_workspace_id: null },
      options: { path: "/tmp/test.sock" },
    },
  ]);
});

test("close asks Herdr to close the workspace without closing its group", async () => {
  const { calls, call } = recordingCaller();
  const client = createWorkspaceClient({ path: "/tmp/test.sock", call });

  await client.close("w2");

  expect(calls).toEqual([
    {
      method: "workspace.close",
      params: { workspace_id: "w2" },
      options: { path: "/tmp/test.sock" },
    },
  ]);
});
