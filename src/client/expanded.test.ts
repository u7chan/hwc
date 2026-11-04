import { expect, test } from "bun:test";
import type { AppState } from "../server/herdr/state";
import { applyOpenGroups, parseOpenGroups, rememberGroup } from "./expanded";
import { groupIds } from "./select";

test("the remembered open and closed groups survive a round trip", () => {
  const stored = rememberGroup(rememberGroup(new Map(), "w1", false), "w1:t1", true);
  const parsed = parseOpenGroups(JSON.stringify(Object.fromEntries(stored)));

  expect([...parsed].sort()).toEqual([
    ["w1", false],
    ["w1:t1", true],
  ]);
});

test("a broken value means nothing was remembered", () => {
  expect(parseOpenGroups(null).size).toBe(0);
  expect(parseOpenGroups("{" + '"w1": "yes"}').size).toBe(0);
  expect(parseOpenGroups("[1,2]").size).toBe(0);
  expect(parseOpenGroups("not json").size).toBe(0);
});

test("remembering a group keeps the other entries", () => {
  const stored = rememberGroup(new Map([["w1", false]]), "w2", true);
  expect([...stored].sort()).toEqual([
    ["w1", false],
    ["w2", true],
  ]);
});

test("the default opening follows the remembered state for groups that exist", () => {
  const base = new Set(["w1"]);
  const existing = new Set(["w1", "w1:t1"]);
  const next = applyOpenGroups(
    base,
    new Map([
      ["w1", false],
      ["w1:t1", true],
    ]),
    existing,
  );
  expect([...next]).toEqual(["w1:t1"]);
});

test("a remembered group that is gone does not open anything", () => {
  const base = new Set(["w1"]);
  const next = applyOpenGroups(base, new Map([["w9", true]]), new Set(["w1"]));
  expect([...next]).toEqual(["w1"]);
});

const state: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "idle",
      focused: true,
      worktree: {
        repoName: "hwc",
        repoRoot: "/home/dev/workspace/hwc",
        checkoutPath: "/home/dev/workspace/hwc",
        isLinkedWorktree: false,
      },
      tabs: [{ id: "w1:t1", label: "1", agentStatus: "idle", focused: true, panes: [] }],
    },
  ],
};

test("the switchable units are workspaces, tabs and repository groups", () => {
  expect([...groupIds(state)].sort()).toEqual(["repo:hwc", "w1", "w1:t1"]);
});
