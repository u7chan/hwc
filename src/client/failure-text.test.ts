import { expect, test } from "bun:test";
import {
  CLOSE_FAILED_NOTICE,
  CLOSE_SPACE_FAILED_NOTICE,
  EXIT_FAILED_NOTICE,
  INVALID_REQUEST_NOTICE,
  PANE_NOT_FOUND_NOTICE,
  REMOVE_WORKTREE_FAILED_NOTICE,
  closeFailureNotice,
} from "./failure-text";
import { saveNotificationText } from "./notifications";
import { spaceFailureNotice } from "./space-create";
import { launchFailureMessage } from "./starting";
import { worktreeFailureNotice } from "./worktree-create";

// 同じ失敗を別の画面で言い直していないこと。ダイアログごとに文言が分かれると、
// 直すときに取りこぼす。すべての mapping が共有の定数を返すことを出力で確かめる。

test("an invalid input keeps the one wording across every form", () => {
  expect(INVALID_REQUEST_NOTICE).toBe("入力内容を確認してください。");
  expect(saveNotificationText("invalid_request")).toBe(INVALID_REQUEST_NOTICE);
  expect(spaceFailureNotice("invalid_request").message).toBe(INVALID_REQUEST_NOTICE);
  expect(launchFailureMessage("invalid_request")).toBe(INVALID_REQUEST_NOTICE);
  expect(worktreeFailureNotice("invalid_request").message).toBe(INVALID_REQUEST_NOTICE);
});

test("a pane that is gone keeps the one wording wherever it is reported", () => {
  expect(PANE_NOT_FOUND_NOTICE).toBe("ペインが見つかりませんでした。");
  expect(spaceFailureNotice("pane_not_found").message).toBe(PANE_NOT_FOUND_NOTICE);
  expect(launchFailureMessage("pane_not_found")).toBe(PANE_NOT_FOUND_NOTICE);
});

// 閉じる要求と終了要求は、通らなかったときに次にすることも違う。対象が残ることは同じ。
test("a failed close says what is left to do for the action that was asked", () => {
  expect(closeFailureNotice("close")).toBe(CLOSE_FAILED_NOTICE);
  expect(closeFailureNotice("exit")).toBe(EXIT_FAILED_NOTICE);
  expect(CLOSE_FAILED_NOTICE).toBe("閉じられませんでした。もう一度お試しください。");
  expect(EXIT_FAILED_NOTICE).toBe("終了を要求できませんでした。Herdr 側の状態を確認してください。");
});

// 閉じる・削除の失敗は、残るもの（ペイン・スペース・チェックアウト）で文言が分かれる。
test("a failed close or removal names what stays and where to look", () => {
  expect(CLOSE_SPACE_FAILED_NOTICE).toBe(
    "閉じられませんでした。Herdr 側の状態を確認してください。",
  );
  expect(REMOVE_WORKTREE_FAILED_NOTICE).toBe(
    "削除できませんでした。Herdr 側の状態を確認してください。",
  );
});
