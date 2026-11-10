import { expect, test } from "bun:test";
import type { AgentStatus } from "./contract";
import {
  NO_TIMES,
  type PaneTimes,
  type SavedPaneTimes,
  parseSavedPaneTimes,
  restorePaneTimes,
  toSavedPaneTimes,
  trackPaneTimes,
} from "./pane-times";
import type { SnapshotState } from "./state";

function statuses(...list: AgentStatus[]): SnapshotState {
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
            panes: list.map((agentStatus, index) => ({
              id: `w1:p${index + 1}`,
              title: null,
              label: null,
              agent: "pi",
              agentStatus,
              focused: false,
              chat: false,
            })),
          },
        ],
      },
    ],
  };
}

test("a pane that starts working gets the time it started", () => {
  const first = trackPaneTimes(null, NO_TIMES, statuses("working"), 1_000, true);

  expect(first.workingSince).toEqual({ "w1:p1": 1_000 });
  // 働き続けている間は起点を動かさない。
  const later = trackPaneTimes(statuses("working"), first, statuses("working"), 90_000, true);
  expect(later.workingSince).toEqual({ "w1:p1": 1_000 });
  expect(later).toBe(first);
});

test("a pane that leaves working loses its start time", () => {
  const working = trackPaneTimes(null, NO_TIMES, statuses("working"), 1_000, true);
  const paused = trackPaneTimes(statuses("working"), working, statuses("idle"), 5_000, true);

  expect(paused.workingSince).toEqual({});
  // 再び働き始めたら、その時点から数え直す。
  const again = trackPaneTimes(statuses("idle"), paused, statuses("working"), 9_000, true);
  expect(again.workingSince).toEqual({ "w1:p1": 9_000 });
});

test("a pane that leaves working for done or idle remembers when it finished", () => {
  const working = trackPaneTimes(null, NO_TIMES, statuses("working"), 1_000, true);

  const done = trackPaneTimes(statuses("working"), working, statuses("done"), 9_000, true);
  expect(done.finishedAt).toEqual({ "w1:p1": 9_000 });
  // 記録した終了時刻は、状態が変わらない間は動かさない。
  const still = trackPaneTimes(statuses("done"), done, statuses("done"), 12_000, true);
  expect(still.finishedAt).toEqual({ "w1:p1": 9_000 });

  const idle = trackPaneTimes(statuses("idle"), NO_TIMES, statuses("idle"), 9_000, true);
  expect(idle.finishedAt).toEqual({});
});

test("a pane that was already resting has no time to remember", () => {
  const previous = statuses("idle");
  const finished = trackPaneTimes(previous, NO_TIMES, statuses("done"), 9_000, true);

  // 直前の観測で working でなかったペインの終了時刻は知らない。
  expect(finished.finishedAt).toEqual({});
});

test("going back to work or needing attention drops the finished time", () => {
  const done = trackPaneTimes(statuses("working"), NO_TIMES, statuses("done"), 1_000, true);
  // 起点を持たない working でも、終了時刻は消える。
  const working = trackPaneTimes(statuses("done"), done, statuses("working"), 9_000, true);
  expect(working.finishedAt).toEqual({});

  // 要対応は待ち時間ではなく、こちらが動く番。
  const blocked = trackPaneTimes(statuses("done"), done, statuses("blocked"), 9_000, true);
  expect(blocked.finishedAt).toEqual({});
  expect(blocked.workingSince).toEqual({});
});

test("only a transition the BFF saw is written down", () => {
  const working = trackPaneTimes(null, NO_TIMES, statuses("working"), 1_000, true);

  // 接続の切れ目をまたいだ遷移は、観測していないので記録しない。
  const missed = trackPaneTimes(statuses("working"), working, statuses("done"), 9_000, false);
  expect(missed.finishedAt).toEqual({});
  expect(missed.workingSince).toEqual({});

  // 切れ目の前に記録した終了時刻は、切れ目の後でも残す。
  const recorded = trackPaneTimes(statuses("working"), working, statuses("done"), 5_000, true);
  const kept = trackPaneTimes(statuses("done"), recorded, statuses("done"), 9_000, false);
  expect(kept.finishedAt).toEqual({ "w1:p1": 5_000 });
});

test("a break in observation does not stop the start time", () => {
  const missed = trackPaneTimes(statuses("idle"), NO_TIMES, statuses("working"), 9_000, false);

  // 切断中に働き始めたペインも、見た時点から数える。数えないと経過が出ない。
  expect(missed.workingSince).toEqual({ "w1:p1": 9_000 });
});

test("a pane that is gone loses its times", () => {
  const working = trackPaneTimes(null, NO_TIMES, statuses("working", "done"), 1_000, true);
  const recorded = trackPaneTimes(
    statuses("working", "done"),
    working,
    statuses("idle", "done"),
    2_000,
    true,
  );
  expect(recorded.finishedAt).toEqual({ "w1:p1": 2_000 });

  const gone = trackPaneTimes(statuses("idle", "done"), recorded, statuses("unknown"), 9_000, true);
  expect(gone.finishedAt).toEqual({});
  expect(gone.workingSince).toEqual({});
});

test("a saved working pane keeps its start only while it is still working", () => {
  const saved: SavedPaneTimes = {
    "w1:p1": { status: "working", at: 1_000 },
    "w1:p2": { status: "idle", at: 2_000 },
  };

  const restored = restorePaneTimes(saved, statuses("working", "idle"));
  expect(restored.workingSince).toEqual({ "w1:p1": 1_000 });
  // 状態が一致する終了時刻は引き継ぐ。
  expect(restored.finishedAt).toEqual({ "w1:p2": 2_000 });

  // 一致しない working は、最初の観測から数え直す。
  const restarted = trackPaneTimes(null, restored, statuses("done", "working"), 9_000, false);
  expect(restarted.workingSince).toEqual({ "w1:p2": 9_000 });
  // 再起動で working に戻っていたペインの終了時刻は捨てる。
  expect(restarted.finishedAt).toEqual({});
});

test("a saved finished time survives a restart only for the same status", () => {
  const saved: SavedPaneTimes = { "w1:p1": { status: "done", at: 1_000 } };

  expect(restorePaneTimes(saved, statuses("done")).finishedAt).toEqual({ "w1:p1": 1_000 });
  expect(restorePaneTimes(saved, statuses("idle")).finishedAt).toEqual({});
  expect(restorePaneTimes(saved, statuses("working")).finishedAt).toEqual({});
});

test("a saved time is read back only for the states that show a time", () => {
  const state = statuses("working", "done", "idle", "unknown");
  const times: PaneTimes = {
    workingSince: { "w1:p1": 1_000 },
    finishedAt: { "w1:p2": 2_000, "w1:p3": 3_000, "w1:p4": 4_000 },
  };

  // 時刻を出さない状態の項目は保存しない。
  expect(toSavedPaneTimes(state, times)).toEqual({
    "w1:p1": { status: "working", at: 1_000 },
    "w1:p2": { status: "done", at: 2_000 },
    "w1:p3": { status: "idle", at: 3_000 },
  });
});

test("a saved file is read back, dropping broken values", () => {
  const raw = JSON.stringify({
    "w1:p1": { status: "working", at: 1_000 },
    "w1:p2": { status: "done", at: 2_000 },
  });
  expect(parseSavedPaneTimes(raw, 5_000)).toEqual({
    "w1:p1": { status: "working", at: 1_000 },
    "w1:p2": { status: "done", at: 2_000 },
  });

  // 未来の値・非数・知らない状態・壊れた JSON は捨てる。
  expect(
    parseSavedPaneTimes(
      JSON.stringify({
        "w1:p1": { status: "working", at: 9_000 },
        "w1:p2": { status: "working", at: "1000" },
        "w1:p3": { status: "blocked", at: 1_000 },
        // JSON の数として読めるが有限でない値。
        "w1:p4": { status: "done", at: Number.POSITIVE_INFINITY },
        "w1:p5": 1_000,
      }),
      5_000,
    ),
  ).toEqual({});
  expect(parseSavedPaneTimes("not json", 5_000)).toEqual({});
  expect(parseSavedPaneTimes("[1000]", 5_000)).toEqual({});
  expect(parseSavedPaneTimes(null, 5_000)).toEqual({});
});
