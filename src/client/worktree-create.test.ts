import { expect, test } from "bun:test";
import {
  worktreeFailureNotice,
  worktreeOutcomeUnknown,
  worktreePartialNotice,
} from "./worktree-create";

const UNKNOWN = "作成できたか確認できませんでした";

test("a creation whose result is unknown is not presented as a confirmed failure", () => {
  // 通信断・応答の読み取り失敗・期限切れは、ワークツリーが残っている可能性がある。
  for (const error of ["failed", "timeout", "herdr_unavailable"] as const) {
    expect(worktreeOutcomeUnknown(error)).toBe(true);
    const notice = worktreeFailureNotice(error);
    expect(notice.message.startsWith(UNKNOWN)).toBe(true);
    // 作成済みを残したまま 2 つ目を作らないよう、再送させない。
    expect(notice.retry).toBe(false);
  }
});

test("an explicit creation failure is still a failure that can be retried", () => {
  const failed = worktreeFailureNotice("worktree_create_failed");
  expect(failed.message).toBe("ワークツリーを作成できませんでした。もう一度お試しください。");
  expect(failed.retry).toBe(true);

  const busy = worktreeFailureNotice("worktree_operation_in_progress");
  expect(busy.message).toContain("操作が実行中");
  expect(busy.retry).toBe(true);
});

test("a failed open asks for a Herdr check without offering a retry", () => {
  const notice = worktreeFailureNotice("worktree_open_failed");
  expect(notice.message).toContain("スペースを開けませんでした");
  expect(notice.retry).toBe(false);
});

test("a source the server refuses is reported without a retry", () => {
  for (const error of [
    "linked_worktree_source",
    "not_git_worktree",
    "workspace_not_found",
    "invalid_request",
  ] as const) {
    expect(worktreeOutcomeUnknown(error)).toBe(false);
    expect(worktreeFailureNotice(error).retry).toBe(false);
  }
});

test("a partial success says what is left behind", () => {
  expect(worktreePartialNotice("agent_start_failed")).toContain("シェルとして残って");
  expect(worktreePartialNotice("pane_rename_failed")).toContain("ペイン名を設定できませんでした");
});
