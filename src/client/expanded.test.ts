import { expect, test } from "bun:test";
import { type AppState, NO_TIMES } from "../server/herdr/state";
import {
  OPEN_GROUPS_STORAGE_KEY,
  applyOpenGroups,
  loadOpenGroups,
  parseOpenGroups,
  rememberGroup,
  saveOpenGroups,
} from "./expanded";
import { groupIds } from "./select";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function deniedStorage() {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
}

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

test("the open groups keep the storage key they are read from", () => {
  expect(OPEN_GROUPS_STORAGE_KEY).toBe("hwc-open-groups");
});

test("the remembered groups are stored as one JSON object", () => {
  const store = memoryStorage();
  saveOpenGroups(store, rememberGroup(rememberGroup(new Map(), "w1", false), "w1:t1", true));

  expect(store.map.get(OPEN_GROUPS_STORAGE_KEY)).toBe('{"w1":false,"w1:t1":true}');
  expect([...loadOpenGroups(store)].sort()).toEqual([
    ["w1", false],
    ["w1:t1", true],
  ]);
});

test("an unreadable store remembers nothing", () => {
  expect(loadOpenGroups(memoryStorage()).size).toBe(0);
  expect(loadOpenGroups(memoryStorage({ [OPEN_GROUPS_STORAGE_KEY]: "not json" })).size).toBe(0);
  expect(loadOpenGroups(deniedStorage()).size).toBe(0);
  expect(loadOpenGroups(null).size).toBe(0);
  expect(() => saveOpenGroups(deniedStorage(), new Map([["w1", true]]))).not.toThrow();
  expect(() => saveOpenGroups(null, new Map([["w1", true]]))).not.toThrow();
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
  times: NO_TIMES,
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
        managed: true,
      },
      tabs: [{ id: "w1:t1", label: "1", agentStatus: "idle", focused: true, panes: [] }],
    },
  ],
};

test("the switchable units are workspaces, tabs and repository groups", () => {
  expect([...groupIds(state)].sort()).toEqual(["repo:hwc", "w1", "w1:t1"]);
});
