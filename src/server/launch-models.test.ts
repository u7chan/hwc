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

const beam = { provider: "example", id: "beam" };

test("fills an empty snapshot with the model and effort chosen at startup", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");

  expect(launch.apply("w1:p2", empty)).toEqual({ ...empty, model: "beam", effort: "low" });
});

test("leaves an unselected effort unset and other panes untouched", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, null);

  expect(launch.apply("w1:p2", empty)).toEqual({ ...empty, model: "beam", effort: null });
  expect(launch.apply("w1:p3", empty)).toEqual(empty);
});

test("keeps the effort the session already knows", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");

  expect(launch.apply("w1:p2", { ...empty, effort: "high" })).toEqual({
    ...empty,
    model: "beam",
    effort: "high",
  });
});

test("yields to the session once it records a model and forgets the selection", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");
  const recorded = { ...empty, etag: "etag-2", model: "beam-mini" };

  expect(launch.apply("w1:p2", recorded)).toEqual(recorded);
  expect(launch.apply("w1:p2", empty)).toEqual(empty);
});

test("stops filling a pane that was forgotten", () => {
  const launch = createLaunchModels();
  launch.remember("w1:p2", beam, "low");
  launch.forget("w1:p2");

  expect(launch.apply("w1:p2", empty)).toEqual(empty);
});
