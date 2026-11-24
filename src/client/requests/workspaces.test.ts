import { expect, test } from "bun:test";
import {
  CREATE_WORKTREE_TIMEOUT_MS,
  canRetryWorktree,
  parseAppState,
  toAppState,
  toWorktreeError,
} from "./workspaces";

const state = {
  focusedWorkspaceId: null,
  focusedTabId: null,
  focusedPaneId: null,
  times: { workingSince: {}, finishedAt: {} },
  workspaces: [],
};

test("a state body needs a workspaces array", () => {
  expect(toAppState(state)).toEqual(state);
  expect(toAppState({ workspaces: "w1" })).toBeNull();
  expect(toAppState(null)).toBeNull();
});

test("a message carries the state and the server clock it was sent with", () => {
  expect(parseAppState(JSON.stringify({ state, now: 1_000 }))).toEqual({ state, now: 1_000 });
  // 読めない now でも状態は適用し、時計だけ据え置く。
  expect(parseAppState(JSON.stringify({ state }))).toEqual({ state, now: null });
  expect(parseAppState(JSON.stringify({ state, now: "1000" }))).toEqual({ state, now: null });
});

test("a broken event body is dropped instead of thrown", () => {
  expect(parseAppState("{")).toBeNull();
  expect(parseAppState('"state"')).toBeNull();
  expect(parseAppState(JSON.stringify(state))).toBeNull();
  expect(parseAppState(JSON.stringify({ now: 1_000 }))).toBeNull();
});

test("a worktree error keeps the ids only when the checkout already exists", () => {
  expect(
    toWorktreeError({ error: "pane_rename_failed", workspaceId: "w2", paneId: "w2:p1" }),
  ).toEqual({ error: "pane_rename_failed", workspaceId: "w2", paneId: "w2:p1" });
  expect(toWorktreeError({ error: "worktree_open_failed" })).toEqual({
    error: "worktree_open_failed",
    workspaceId: null,
    paneId: null,
  });
  expect(toWorktreeError({ error: "herdr_unavailable" })).toEqual({
    error: "herdr_unavailable",
    workspaceId: null,
    paneId: null,
  });
  expect(toWorktreeError({ error: "pane_limit" })).toEqual({
    error: "failed",
    workspaceId: null,
    paneId: null,
  });
  expect(toWorktreeError(null)).toEqual({ error: "failed", workspaceId: null, paneId: null });
});

test("only an explicit creation failure or a busy checkout can be retried", () => {
  // Herdr が作成失敗を明示した場合と、同じチェックアウトへの同時操作だけ。
  expect(canRetryWorktree("worktree_create_failed")).toBe(true);
  expect(canRetryWorktree("worktree_operation_in_progress")).toBe(true);
  // 作成できたか確認できない失敗は、再送で 2 つ目のワークツリーを作りかねない。
  expect(canRetryWorktree("worktree_open_failed")).toBe(false);
  expect(canRetryWorktree("herdr_unavailable")).toBe(false);
  expect(canRetryWorktree("timeout")).toBe(false);
  expect(canRetryWorktree("failed")).toBe(false);
  // 起点を変える必要がある失敗は、同じ入力を送り直しても通らない。
  expect(canRetryWorktree("linked_worktree_source")).toBe(false);
  expect(canRetryWorktree("not_git_worktree")).toBe(false);
  expect(canRetryWorktree("workspace_not_found")).toBe(false);
});

test("the worktree timeout covers the worktree creation", () => {
  expect(CREATE_WORKTREE_TIMEOUT_MS).toBeGreaterThan(90_000);
});
