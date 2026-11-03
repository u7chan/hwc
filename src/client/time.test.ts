import { expect, test } from "bun:test";
import type { AppState } from "../server/herdr/state";
import {
  formatClock,
  formatElapsed,
  parseWorkingSince,
  trackWorking,
  workingMs,
  workingSinceForSave,
} from "./time";

test("elapsed reads as seconds, minutes and hours", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(9_400)).toBe("9s");
  expect(formatElapsed(61_000)).toBe("1m 1s");
  expect(formatElapsed(59 * 60_000)).toBe("59m 0s");
  expect(formatElapsed(3_600_000)).toBe("1h 0m");
  expect(formatElapsed(2 * 3_600_000 + 2 * 60_000 + 5_000)).toBe("2h 2m");
  expect(formatElapsed(-5_000)).toBe("0s");
});

test("a message time reads as hours and minutes", () => {
  expect(formatClock(new Date(2026, 10, 2, 9, 5).getTime())).toBe("09:05");
  expect(formatClock(new Date(2026, 10, 2, 23, 59).getTime())).toBe("23:59");
});

test("the wait for a reply counts from the moment the pane started working", () => {
  const since = new Map([["w1:p1", 1_000]]);

  expect(workingMs(since, "w1:p1", 31_000)).toBe(30_000);
  // 覚えていないペインには経過を出さない。
  expect(workingMs(since, "w1:p2", 31_000)).toBeNull();
  // 端末の時計が戻っても負の値は出さない。
  expect(workingMs(since, "w1:p1", 0)).toBe(0);
});

const state: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "working",
      focused: true,
      worktree: null,
      tabs: [
        {
          id: "w1:t1",
          label: "main",
          agentStatus: "working",
          focused: true,
          panes: [
            {
              id: "w1:p1",
              title: null,
              label: null,
              agent: "pi",
              agentStatus: "working",
              focused: true,
              chat: false,
            },
            {
              id: "w1:p2",
              title: null,
              label: null,
              agent: "bash",
              agentStatus: "idle",
              focused: false,
              chat: false,
            },
          ],
        },
      ],
    },
  ],
};

test("a pane that starts working gets the time it started", () => {
  const first = trackWorking(new Map(), state, 1_000);
  expect([...first]).toEqual([["w1:p1", 1_000]]);

  const later = trackWorking(first, state, 90_000);
  expect([...later]).toEqual([["w1:p1", 1_000]]);
  expect(later).toBe(first);
});

test("a pane that leaves the working state loses its start time", () => {
  const started = trackWorking(new Map(), state, 1_000);
  const paused: AppState = {
    ...state,
    workspaces: [
      {
        ...state.workspaces[0],
        tabs: [
          {
            ...state.workspaces[0].tabs[0],
            panes: [{ ...state.workspaces[0].tabs[0].panes[0], agentStatus: "idle" }],
          },
        ],
      },
    ],
  };

  expect(trackWorking(started, paused, 5_000).size).toBe(0);
  // 再び働き始めたら、その時点から数え直す。
  expect([...trackWorking(new Map(), state, 9_000)]).toEqual([["w1:p1", 9_000]]);
});

const workingState: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
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
              agentStatus: "working",
              focused: false,
              chat: false,
            },
            {
              id: "w1:p2",
              title: null,
              label: null,
              agent: "pi",
              agentStatus: "idle",
              focused: false,
              chat: false,
            },
          ],
        },
      ],
    },
  ],
};

test("a saved start time is read back from the device", () => {
  const since = parseWorkingSince('{"w1:p1":1000,"w1:p2":2000}', 5_000);

  expect([...since]).toEqual([
    ["w1:p1", 1_000],
    ["w1:p2", 2_000],
  ]);
});

test("a saved start time that cannot be a number is dropped", () => {
  const raw = JSON.stringify({ "w1:p1": "1000", "w1:p2": null, "w1:p3": 1_000.5 });

  // 文字列と null は捨て、数だけを受ける。
  expect([...parseWorkingSince(raw, 5_000)]).toEqual([["w1:p3", 1_000.5]]);
  expect([...parseWorkingSince('{"w1:p1":1e999}', 5_000)]).toEqual([]);
  expect([...parseWorkingSince("not json", 5_000)]).toEqual([]);
  expect([...parseWorkingSince("[1000]", 5_000)]).toEqual([]);
  expect([...parseWorkingSince(null, 5_000)]).toEqual([]);
});

test("a saved start time in the future is dropped", () => {
  const since = parseWorkingSince('{"w1:p1":9000,"w1:p2":1000}', 5_000);

  // 端末の時計が戻っても、負の経過を出さない。
  expect([...since]).toEqual([["w1:p2", 1_000]]);
});

test("a restored start time survives only while the pane is working", () => {
  const restored = parseWorkingSince('{"w1:p1":1000,"w1:p2":2000}', 5_000);
  const kept = trackWorking(restored, workingState, 9_000);

  // w1:p1 は働き続けているので起点を引き継ぐ。w1:p2 は止まったので捨てる。
  expect([...kept]).toEqual([["w1:p1", 1_000]]);
});

test("only the working panes are written back to the device", () => {
  const since = new Map([
    ["w1:p1", 1_000],
    ["w1:p2", 2_000],
    ["w9:p1", 3_000],
  ]);

  // 止まったペインと、もう居ないペインは保存しない。
  expect(workingSinceForSave(workingState, since)).toEqual({ "w1:p1": 1_000 });
});
