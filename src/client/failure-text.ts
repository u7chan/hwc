import type { PaneCloseAction } from "../shared/pane-close";

// 同じ失敗を別のダイアログで言い直さない。文言を直すときはこのファイルだけを直す。

// 入力の不備。どの操作から来ても、直すべきは同じフォームの中身。
export const INVALID_REQUEST_NOTICE = "入力内容を確認してください。";

// 対象のペインがもう無い。開き直す以外に打つ手が無いので、操作の種類によらず同じ言い方にする。
export const PANE_NOT_FOUND_NOTICE = "ペインが見つかりませんでした。";

// 閉じる要求は通らなかった。ペインは残っているので、同じ操作をもう一度試せる。
export const CLOSE_FAILED_NOTICE = "閉じられませんでした。もう一度お試しください。";

// 終了の要求は通らなかった。ペインが残るのは閉じる場合と同じだが、次の一手は Herdr 側にある。
export const EXIT_FAILED_NOTICE = "終了を要求できませんでした。Herdr 側の状態を確認してください。";

// スペースは残っているが、閉じられなかった。作業ディレクトリの状態は Herdr が持つ。
export const CLOSE_SPACE_FAILED_NOTICE = "閉じられませんでした。Herdr 側の状態を確認してください。";

// 削除できなかった。チェックアウトが残っているかは Herdr 側で決まる。
export const REMOVE_WORKTREE_FAILED_NOTICE =
  "削除できませんでした。Herdr 側の状態を確認してください。";

// ペインを閉じる要求の失敗は、閉じるか終了を要求するかで次の一手が違う。
export function closeFailureNotice(action: PaneCloseAction): string {
  return action === "exit" ? EXIT_FAILED_NOTICE : CLOSE_FAILED_NOTICE;
}
