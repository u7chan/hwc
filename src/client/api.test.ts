import { expect, test } from "bun:test";
import { closeOutcome, toCreatedSpace } from "./api";

test("close is done once the pane is gone, whatever removed it", () => {
  // 404 は「BFF の状態に無い」と「Herdr が pane_not_found」のどちらでも、閉じる目的は達している。
  expect(closeOutcome(404)).toBe("done");
  expect(closeOutcome(200)).toBe("done");
});

test("close fails on any other status", () => {
  expect(closeOutcome(400)).toBe("failed");
  expect(closeOutcome(409)).toBe("failed");
  expect(closeOutcome(415)).toBe("failed");
  expect(closeOutcome(502)).toBe("failed");
});

test("the created worktree ids are read from the response", () => {
  expect(toCreatedSpace({ workspaceId: "w2", paneId: "w2:p1" })).toEqual({
    workspaceId: "w2",
    paneId: "w2:p1",
  });
  expect(toCreatedSpace({ workspaceId: "w2" })).toBeNull();
  expect(toCreatedSpace({ workspaceId: "", paneId: "w2:p1" })).toBeNull();
  expect(toCreatedSpace({ workspaceId: "w2", paneId: 1 })).toBeNull();
  expect(toCreatedSpace(null)).toBeNull();
});
