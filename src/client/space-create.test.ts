import { expect, test } from "bun:test";
import type { CreateSpaceFailure } from "./api";
import { spaceFailureNotice } from "./space-create";
import { UNKNOWN_NOTICE } from "./worktree-create";

test("a space whose creation cannot be confirmed is not sent again", () => {
  for (const error of ["timeout", "failed", "herdr_unavailable"] as CreateSpaceFailure[]) {
    expect(spaceFailureNotice(error)).toEqual({ message: UNKNOWN_NOTICE, retry: false });
  }
});

test("a folder that is gone asks to reopen the tree instead of retrying", () => {
  const notice = spaceFailureNotice("not_found");
  expect(notice.retry).toBe(false);
  expect(notice.message).toContain("ツリーを開き直して");
});

test("only an invalid input keeps the form for another try", () => {
  expect(spaceFailureNotice("invalid_request").retry).toBe(true);
  for (const error of ["no_checkout", "pane_not_found"] as CreateSpaceFailure[]) {
    expect(spaceFailureNotice(error).retry).toBe(false);
  }
});
