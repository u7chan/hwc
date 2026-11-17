import { expect, test } from "bun:test";
import type { ChatSnapshot } from "./chat/contract";
import { createLaunchModels } from "./launch-models";

const empty: ChatSnapshot = {
  etag: "etag-1",
  messages: [],
  model: null,
  effort: null,
  truncated: false,
  context: null,
  compaction: null,
};

const filledEtag = "etag-1+launch";

const beam = { provider: "example", id: "beam" };

test("fills an empty snapshot with the model and effort chosen at startup", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");

  expect(launch.apply("w1:p2", empty)).toEqual({
    ...empty,
    etag: filledEtag,
    model: "beam",
    effort: "low",
  });
});

test("leaves an unselected effort unset and other panes untouched", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, null);

  expect(launch.apply("w1:p2", empty)).toEqual({
    ...empty,
    etag: filledEtag,
    model: "beam",
    effort: null,
  });
  expect(launch.apply("w1:p3", empty)).toEqual(empty);
});

test("keeps the effort the session already knows", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");

  expect(launch.apply("w1:p2", { ...empty, effort: "high" })).toEqual({
    ...empty,
    etag: filledEtag,
    model: "beam",
    effort: "high",
  });
});

test("keeps the filled etag stable so unchanged clients can keep the snapshot", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");

  const first = launch.apply("w1:p2", empty).etag;
  const second = launch.apply("w1:p2", empty).etag;

  // 補完前の etag とは別にし、補完している間は同じ値を返す。
  expect(first).not.toBe(empty.etag);
  expect(second).toBe(first);
});

test("yields to the session and keeps the selection for the next empty conversation", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");
  const recorded = { ...empty, etag: "etag-2", model: "beam-mini" };

  // 会話にモデルが載っている間は、セッションの値だけを出す。
  expect(launch.apply("w1:p2", recorded)).toEqual(recorded);
  // /new で会話が空に戻ったら、また起動時の指定で補う。
  expect(launch.apply("w1:p2", empty)).toEqual({
    ...empty,
    etag: filledEtag,
    model: "beam",
    effort: "low",
  });
});

test("stops filling a pane that was forgotten", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");
  launch.forget("w1:p2");

  expect(launch.apply("w1:p2", empty)).toEqual(empty);
});
