import { expect, test } from "bun:test";
import type { AppState } from "../server/herdr/state";
import { gateSnapshot, nextObservation } from "./snapshot";
import { trackFinished } from "./time";

test("the initial fetch fills in the state until the stream speaks", () => {
  expect(gateSnapshot("initial-fetch", "initial-fetch")).toEqual({
    writer: "initial-fetch",
    apply: true,
  });
});

test("the stream snapshot takes over and is always applied", () => {
  expect(gateSnapshot("initial-fetch", "stream")).toEqual({ writer: "stream", apply: true });
  expect(gateSnapshot("stream", "stream")).toEqual({ writer: "stream", apply: true });
});

test("a late initial fetch does not overwrite the streamed state", () => {
  expect(gateSnapshot("stream", "initial-fetch")).toEqual({ writer: "stream", apply: false });
});

function doneState(): AppState {
  return {
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
    workspaces: [
      {
        id: "w1",
        label: "hwc",
        agentStatus: "unknown",
        focused: false,
        worktree: null,
        tabs: [
          {
            id: "w1:t1",
            label: "1",
            agentStatus: "unknown",
            focused: false,
            panes: [
              {
                id: "w1:p1",
                title: null,
                label: null,
                agent: "pi",
                agentStatus: "done",
                focused: false,
                chat: false,
              },
            ],
          },
        ],
      },
    ],
  };
}

// 直前の観測で working だったペイン。ここから done へ移ったかを見る。
const worked = new Map([["w1:p1", 1_000]]);

test("the first snapshot at mount is the start of an observation, not a transition", () => {
  // まだ接続状態を観測していない。
  const first = nextObservation(true, "connecting");

  expect(first).toBe(true);
  expect(trackFinished(new Map(), worked, doneState(), 9_000, !first)).toEqual(new Map());
});

test("the first snapshot after a drop is the start of an observation too", () => {
  const dropped = nextObservation(false, "reconnecting");
  expect(dropped).toBe(true);

  // スナップショットと live は同じ更新で届く。live だけで観測中と判断しない。
  const first = nextObservation(dropped, "live");
  expect(first).toBe(true);
  expect(trackFinished(new Map(), worked, doneState(), 9_000, !first)).toEqual(new Map());
});

test("a snapshot while the connection stays live is observed, so the transition counts", () => {
  const first = nextObservation(false, "live");

  expect(first).toBe(false);
  expect(trackFinished(new Map(), worked, doneState(), 9_000, !first)).toEqual(
    new Map([["w1:p1", 9_000]]),
  );
});
