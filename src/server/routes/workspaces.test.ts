import { expect, test } from "bun:test";
import { parseMoveWorkspacesBody } from "./workspaces";

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
