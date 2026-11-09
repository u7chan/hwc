import { expect, test } from "bun:test";
import type { WorkspaceState } from "../server/herdr/state";
import {
  adjacentBeforeKey,
  dropAnchor,
  dropBeforeId,
  isOrderChange,
  orderUnits,
  type OrderUnit,
} from "./order";
import { groupWorkspaces } from "./select";

function workspace(id: string, options: { repo?: string; linked?: boolean } = {}): WorkspaceState {
  const repo = options.repo;
  return {
    id,
    label: id,
    agentStatus: "idle",
    focused: false,
    worktree:
      repo === undefined
        ? null
        : {
            repoName: repo,
            repoRoot: `/work/${repo}`,
            checkoutPath: `/work/${id}`,
            isLinkedWorktree: options.linked === true,
          },
    tabs: [],
  };
}

function unitsOf(workspaces: readonly WorkspaceState[]): readonly OrderUnit[] {
  return orderUnits(groupWorkspaces(workspaces), workspaces);
}

test("a repository group is one unit and keeps its linked worktree", () => {
  const workspaces = [
    workspace("w1", { repo: "acme" }),
    workspace("w2", { repo: "acme", linked: true }),
    workspace("w3"),
  ];

  expect(unitsOf(workspaces)).toEqual([
    { key: "repo:acme", label: "acme", ids: ["w1", "w2"] },
    { key: "w3", label: "w3", ids: ["w3"] },
  ]);
});

test("the block keeps the native workspace order even when a linked worktree comes first", () => {
  const workspaces = [
    workspace("w2", { repo: "acme", linked: true }),
    workspace("w1", { repo: "acme" }),
  ];

  expect(unitsOf(workspaces)).toEqual([{ key: "repo:acme", label: "acme", ids: ["w2", "w1"] }]);
});

test("dropAnchor picks the first remaining block whose middle is below the pointer", () => {
  const rects = [
    { key: "a", top: 0, bottom: 100 },
    { key: "b", top: 120, bottom: 220 },
  ];

  expect(dropAnchor(rects, 0)).toBe("a");
  expect(dropAnchor(rects, 49)).toBe("a");
  expect(dropAnchor(rects, 50)).toBe("b");
  expect(dropAnchor(rects, 169)).toBe("b");
  expect(dropAnchor(rects, 170)).toBeNull();
  expect(dropAnchor([], 100)).toBeNull();
});

test("dropBeforeId uses the first workspace of the anchor block", () => {
  const units = unitsOf([
    workspace("w1", { repo: "acme" }),
    workspace("w2", { repo: "acme", linked: true }),
    workspace("w3"),
  ]);

  expect(dropBeforeId(units, "repo:acme")).toBe("w1");
  expect(dropBeforeId(units, "w3")).toBe("w3");
  expect(dropBeforeId(units, null)).toBeNull();
  expect(dropBeforeId(units, "missing")).toBeNull();
});

test("isOrderChange ignores a drop that keeps the current position", () => {
  const units = unitsOf([workspace("w1"), workspace("w2"), workspace("w3")]);

  expect(isOrderChange(units, "w1", "w2")).toBe(false);
  expect(isOrderChange(units, "w2", "w3")).toBe(false);
  expect(isOrderChange(units, "w3", null)).toBe(false);

  expect(isOrderChange(units, "w1", null)).toBe(true);
  expect(isOrderChange(units, "w2", "w1")).toBe(true);
  expect(isOrderChange(units, "w3", "w2")).toBe(true);
});

test("adjacentBeforeKey moves one block at a time", () => {
  const units = unitsOf([workspace("w1"), workspace("w2"), workspace("w3")]);

  expect(adjacentBeforeKey(units, "w2", -1)).toBe("w1");
  expect(adjacentBeforeKey(units, "w2", 1)).toBeNull();
  expect(adjacentBeforeKey(units, "w1", 1)).toBe("w3");
  expect(adjacentBeforeKey(units, "w3", -1)).toBe("w2");

  expect(adjacentBeforeKey(units, "w1", -1)).toBeUndefined();
  expect(adjacentBeforeKey(units, "w3", 1)).toBeUndefined();
});
