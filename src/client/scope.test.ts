import { expect, test } from "bun:test";
import type { WorkspaceState } from "../server/herdr/state";
import { parseListScope, scopeWorkspaces } from "./scope";

function workspace(id: string, agents: readonly (string | null)[]): WorkspaceState {
  return {
    id,
    label: id,
    agentStatus: "unknown",
    focused: false,
    worktree: null,
    tabs: [
      {
        id: `${id}:t1`,
        label: "1",
        agentStatus: "unknown",
        focused: false,
        panes: agents.map((agent, index) => ({
          id: `${id}:p${index + 1}`,
          title: null,
          label: null,
          agent,
          agentStatus: "unknown" as const,
          focused: false,
          chat: false,
        })),
      },
    ],
  };
}

test("the list starts with the spaces that have an agent", () => {
  expect(parseListScope(null)).toBe("agent");
  expect(parseListScope("agent")).toBe("agent");
  expect(parseListScope("all")).toBe("all");
  // 端末に残った知らない値では、既定に倒す。
  expect(parseListScope("everything")).toBe("agent");
});

test("agent scope keeps the spaces that have an agent and drops shell-only spaces", () => {
  const spaces = [workspace("w1", [null]), workspace("w2", ["pi"]), workspace("w3", [null, null])];

  expect(scopeWorkspaces(spaces, "agent", null).map((space) => space.id)).toEqual(["w2"]);
  expect(scopeWorkspaces(spaces, "all", null).map((space) => space.id)).toEqual(["w1", "w2", "w3"]);
});

test("agent scope keeps the space that is being read", () => {
  const spaces = [workspace("w1", [null]), workspace("w2", ["pi"])];

  // シェルだけのスペースを開いている間は、絞り込んでも消さない。
  expect(scopeWorkspaces(spaces, "agent", "w1:p1").map((space) => space.id)).toEqual(["w1", "w2"]);
  expect(scopeWorkspaces(spaces, "agent", "w9:p1").map((space) => space.id)).toEqual(["w2"]);
});

test("the order stays the order Herdr reports", () => {
  const spaces = [workspace("w3", ["pi"]), workspace("w1", ["claude"]), workspace("w2", [null])];

  expect(scopeWorkspaces(spaces, "agent", null).map((space) => space.id)).toEqual(["w3", "w1"]);
});
