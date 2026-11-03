import { expect, test } from "bun:test";
import type { AppState } from "../server/herdr/state";
import { expandForPane, parseSelectedPane, restorePane } from "./selection";

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
      worktree: null,
      tabs: [
        {
          id: "w1:t1",
          label: "1",
          agentStatus: "idle" as const,
          focused: true,
          panes: [pane("w1:p1"), pane("w1:p2")],
        },
      ],
    },
    {
      id: "w2",
      label: "u7agent",
      agentStatus: "working",
      focused: false,
      worktree: {
        repoName: "u7agent",
        repoRoot: null,
        checkoutPath: null,
        isLinkedWorktree: true,
      },
      tabs: [
        {
          id: "w2:t1",
          label: "",
          agentStatus: "idle" as const,
          focused: false,
          panes: [pane("w2:p1")],
        },
      ],
    },
  ],
};

function pane(id: string) {
  return {
    id,
    title: null,
    label: null,
    agent: "pi",
    agentStatus: "idle" as const,
    focused: false,
    chat: true,
  };
}

test("a stored pane reopens where it was", () => {
  expect(restorePane(state, "w2:p1")).toBe("w2:p1");
});

test("going back to the list is remembered across a reload", () => {
  // 一覧に戻していたなら、ペインが残っていても開き直さない。
  expect(restorePane(state, "w2:p1", true)).toBeNull();
  expect(restorePane(state, null, true)).toBeNull();
});

test("a pane that is gone opens the list instead of another chat", () => {
  expect(restorePane(state, "w2:p9")).toBeNull();
});

test("the first visit opens what herdr focuses", () => {
  expect(restorePane(state, null)).toBe("w1:p1");
});

test("a broken value means nothing was selected", () => {
  expect(parseSelectedPane(null)).toBeNull();
  expect(parseSelectedPane("")).toBeNull();
  expect(parseSelectedPane("w1:p1")).toBe("w1:p1");
});

test("the reopened pane has its workspace and tab open", () => {
  const open = expandForPane(state, "w2:p1", new Set(["w1"]), new Map());
  expect([...open].sort()).toEqual(["repo:u7agent", "w1", "w2", "w2:t1"]);
});

test("a group the user folded stays folded", () => {
  const closed = expandForPane(state, "w2:p1", new Set(["w1"]), new Map([["w2", false]]));
  expect([...closed].sort()).toEqual(["repo:u7agent", "w1", "w2:t1"]);

  const tabClosed = expandForPane(state, "w2:p1", new Set(["w1"]), new Map([["w2:t1", false]]));
  expect([...tabClosed].sort()).toEqual(["repo:u7agent", "w1", "w2"]);
});

test("a pane outside the tree opens nothing extra", () => {
  const open = new Set(["w1"]);
  expect([...expandForPane(state, "w9:p1", open, new Map())]).toEqual(["w1"]);
});
