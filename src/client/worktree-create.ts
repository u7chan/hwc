import { canRetryWorktree, type CreateWorktreeFailure } from "./api";

// 作成できたかを確認できない失敗。ワークツリーとエージェントが残っている可能性があるので、
// 確定した失敗として伝えない。ダイアログは再送させず、Herdr 側の確認を促す（ADR 0038）。
const UNKNOWN_NOTICE =
  "作成できたか確認できませんでした。Herdr のスペースを確認してから、必要なら TUI で開き直してください。";

export function worktreeOutcomeUnknown(error: CreateWorktreeFailure): boolean {
  // 通信断と応答の読み取り失敗は、BFF が作成を終えているか分からない。
  return error === "timeout" || error === "failed" || error === "herdr_unavailable";
}

function knownFailureMessage(error: CreateWorktreeFailure): string {
  switch (error) {
    case "worktree_open_failed":
      return "チェックアウトは作成されましたが、スペースを開けませんでした。Herdr のワークツリーを確認してください。";
    case "worktree_create_failed":
      return "ワークツリーを作成できませんでした。もう一度お試しください。";
    case "worktree_operation_in_progress":
      return "同じワークツリーの操作が実行中です。少し待ってからもう一度お試しください。";
    case "linked_worktree_source":
      return "linked worktree からは作成できません。リポジトリ本体のスペースから作成してください。";
    case "not_git_worktree":
      return "このスペースは git の管理下にありません。";
    case "workspace_not_found":
      return "スペースが見つかりませんでした。";
    case "invalid_request":
      return "入力内容を確認してください。";
    default:
      return "ワークツリーを作成できませんでした。";
  }
}

export function worktreeFailureNotice(error: CreateWorktreeFailure): {
  message: string;
  retry: boolean;
} {
  if (worktreeOutcomeUnknown(error)) return { message: UNKNOWN_NOTICE, retry: false };
  return { message: knownFailureMessage(error), retry: canRetryWorktree(error) };
}

// ワークツリーと root シェルは残っている。黙って閉じず、何が残ったかを伝える。
export function worktreePartialNotice(error: CreateWorktreeFailure): string {
  return error === "agent_start_failed"
    ? "ワークツリーは作成しましたが、エージェントを起動できませんでした。最初のペインはシェルとして残っています。"
    : "ワークツリーは作成しましたが、ペイン名を設定できませんでした。";
}
