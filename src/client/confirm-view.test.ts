import { expect, test } from "bun:test";
import { confirmView } from "./confirm-view";

const CHANGED = "状態が変わりました。確認を閉じて、もう一度操作してください。";

// 対象が消えた・変わったら、理由を出して確認だけ押せなくする。キャンセルは押せる。
test("a target that is gone is told with the one wording and cannot be confirmed", () => {
  const view = confirmView({ available: false });
  expect(view.changedNotice).toBe(CHANGED);
  expect(view.confirmDisabled).toBe(true);
  expect(view.cancelDisabled).toBe(false);
});

test("a target that is still there says nothing about a change", () => {
  expect(confirmView({ available: true }).changedNotice).toBeNull();
  expect(confirmView({}).changedNotice).toBeNull();
  expect(confirmView({}).confirmDisabled).toBe(false);
});

// 失敗の文言は、渡したダイアログだけが自分の欄に出す。
test("a failure notice is shown only when the dialog passes one", () => {
  expect(confirmView({ failedNotice: "削除できませんでした。" }).failedNotice).toBe(
    "削除できませんでした。",
  );
  expect(confirmView({}).failedNotice).toBeNull();
});

// 実行中は結果の反映を 1 回に保つため、キャンセルも確認も受け付けない。
test("a request in flight locks both buttons", () => {
  expect(confirmView({ busy: true })).toEqual({
    changedNotice: null,
    failedNotice: null,
    cancelDisabled: true,
    confirmDisabled: true,
  });
  expect(confirmView({ busy: true, available: false }).confirmDisabled).toBe(true);
});
