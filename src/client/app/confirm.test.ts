import { expect, test } from "bun:test";
import { canConfirm, cancelConfirm, type ConfirmState } from "./confirm";

const open: ConfirmState<{ paneId: string }> = { target: { paneId: "pane-1" }, phase: "confirm" };

// 対象が消えたスナップショットが届いた後と、結果を待つ間は、確認を送り直さない。
test("a confirm is accepted only while the target is there and the result is not on its way", () => {
  expect(canConfirm(open, true)).toBe(true);
  expect(canConfirm(open, false)).toBe(false);
  expect(canConfirm({ ...open, phase: "busy" }, true)).toBe(false);
  expect(canConfirm(null, true)).toBe(false);
});

// 失敗を出している間は、同じ対象にもう一度頼める。leave は確認が既に閉じている。
test("a failed confirm can be tried again, and a leaving one cannot", () => {
  expect(canConfirm({ ...open, phase: "failed" }, true)).toBe(true);
  expect(canConfirm({ ...open, phase: "failed" }, false)).toBe(false);
  expect(canConfirm<{ paneId: string }, "leave">({ ...open, phase: "leave" }, true)).toBe(false);
});

// 結果の反映を待つ間だけ取り消しを受け付けない。それ以外は閉じる（null）。
test("cancelling closes the confirm unless the result is still on its way", () => {
  const busy = { ...open, phase: "busy" } as const;
  expect(cancelConfirm(busy)).toBe(busy);
  expect(cancelConfirm(open)).toBeNull();
  expect(cancelConfirm({ ...open, phase: "failed" })).toBeNull();
  expect(cancelConfirm(null)).toBeNull();
});
