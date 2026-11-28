import { expect, test } from "bun:test";
import type { WorkspaceState } from "../server/herdr/state";
import {
  adjacentBeforeKey,
  dropAnchor,
  dropBeforeId,
  isOrderChange,
  moveToTopPlan,
  orderUnits,
  reorderKeys,
  unitIndex,
  type OrderUnit,
} from "./order";
import { groupWorkspaces } from "./select";

function workspace(
  id: string,
  options: { repo?: string; linked?: boolean; path?: string; label?: string } = {},
): WorkspaceState {
  const repo = options.repo;
  return {
    id,
    label: options.label ?? id,
    path: options.path ?? null,
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
            managed: true,
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

test("native duplicates at the same place move as one unit", () => {
  const workspaces = [
    workspace("w1", { path: "/work/mypi", label: "mypi" }),
    workspace("w2", { path: "/work/mypi", label: "mypi" }),
    workspace("w3", { path: "/work/scratch", label: "scratch" }),
  ];

  expect(unitsOf(workspaces)).toEqual([
    { key: "place:%2Fwork%2Fmypi:mypi", label: "mypi", ids: ["w1", "w2"] },
    { key: "w3", label: "scratch", ids: ["w3"] },
  ]);
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

test("moveToTopPlan moves the block of the workspace before the first block", () => {
  const units = unitsOf([workspace("w1"), workspace("w2"), workspace("w3")]);

  expect(moveToTopPlan(units, "w3")).toEqual({
    ids: ["w3"],
    beforeWorkspaceId: "w1",
  });
});

test("moveToTopPlan moves the whole repository block, whichever member is picked", () => {
  const units = unitsOf([
    workspace("w1"),
    workspace("w2", { repo: "acme" }),
    workspace("w3", { repo: "acme", linked: true }),
  ]);

  // 1 つだけ動かすと、すべてのリポジトリ束が割れる。members をまとめて先頭へ。
  expect(moveToTopPlan(units, "w3")).toEqual({
    ids: ["w2", "w3"],
    beforeWorkspaceId: "w1",
  });
});

test("moveToTopPlan has nothing to do at the top or for an unknown workspace", () => {
  const units = unitsOf([workspace("w1"), workspace("w2")]);

  expect(moveToTopPlan(units, "w1")).toBeNull();
  expect(moveToTopPlan(units, "missing")).toBeNull();
  expect(moveToTopPlan([], "w1")).toBeNull();
});

test("unitIndex tells whether the pending move already landed", () => {
  const units = unitsOf([workspace("w1"), workspace("w2"), workspace("w3")]);

  // 0 は先頭、正の値はまだ下、null は消えたワークスペース。
  expect(unitIndex(units, "w1")).toBe(0);
  expect(unitIndex(units, "w3")).toBe(2);
  expect(unitIndex(units, "missing")).toBeNull();
});

test("reorderKeys puts the grabbed band before the drop target", () => {
  const keys = ["w1", "w2", "w3", "w4"];

  expect(reorderKeys(keys, "w3", "w1")).toEqual(["w3", "w1", "w2", "w4"]);
  expect(reorderKeys(keys, "w1", null)).toEqual(["w2", "w3", "w4", "w1"]);
  expect(reorderKeys(keys, "w4", "w2")).toEqual(["w1", "w4", "w2", "w3"]);
  // 落とし先が無い・掴んだ key が無いときは元の並びのまま。
  expect(reorderKeys(keys, "w2", "missing")).toEqual(keys);
  expect(reorderKeys(keys, "missing", "w1")).toEqual(keys);
});

test("isOrderChange looks only at the keys, so it also fits the active bands", () => {
  // アクティブの带は id を持たない。並べ替えの判定に要るのは key だけ。
  const bands = [{ key: "w1" }, { key: "w2" }];

  expect(isOrderChange(bands, "w2", "w1")).toBe(true);
  expect(isOrderChange(bands, "w1", "w2")).toBe(false);
});
