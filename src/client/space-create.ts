import type { CreateSpaceFailure } from "./api";
import { INVALID_REQUEST_NOTICE, PANE_NOT_FOUND_NOTICE } from "./failure-text";
import { UNKNOWN_NOTICE } from "./worktree-create";

// フォルダから作るスペースの失敗。作成できたか分からないものは再送させない。
export function spaceFailureNotice(error: CreateSpaceFailure): { message: string; retry: boolean } {
  switch (error) {
    case "timeout":
    case "failed":
    case "herdr_unavailable":
      return { message: UNKNOWN_NOTICE, retry: false };
    case "not_found":
      return {
        message: "フォルダが見つかりませんでした。ツリーを開き直してください。",
        retry: false,
      };
    case "no_checkout":
      return { message: "このペインのチェックアウトを読めませんでした。", retry: false };
    case "pane_not_found":
      return { message: PANE_NOT_FOUND_NOTICE, retry: false };
    case "invalid_request":
      return { message: INVALID_REQUEST_NOTICE, retry: true };
    case "pane_rename_failed":
      // スペースはできているので、ダイアログは起動へ進み、ここへは来ない。
      return { message: "ペイン名を付けられませんでした。", retry: false };
  }
}
