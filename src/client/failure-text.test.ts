import { expect, test } from "bun:test";
import { INVALID_REQUEST_NOTICE, PANE_NOT_FOUND_NOTICE } from "./failure-text";
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
