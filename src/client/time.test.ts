import { expect, test } from "bun:test";
import type { AppState } from "../server/herdr/state";
import { formatClock, formatDateTime, formatElapsed, trackWorking } from "./time";

test("elapsed reads as seconds, minutes and hours", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(9_400)).toBe("9s");
  expect(formatElapsed(61_000)).toBe("1m 1s");
  expect(formatElapsed(59 * 60_000)).toBe("59m 0s");
  expect(formatElapsed(3_600_000)).toBe("1h 0m");
  expect(formatElapsed(2 * 3_600_000 + 2 * 60_000 + 5_000)).toBe("2h 2m");
  expect(formatElapsed(-5_000)).toBe("0s");
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
            { id: "w1:p1", title: null, agent: "pi", agentStatus: "working", focused: true },
            { id: "w1:p2", title: null, agent: "bash", agentStatus: "idle", focused: false },
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

test("the clock shows hours and minutes", () => {
  const at = new Date(2026, 10, 1, 9, 5).getTime();
  expect(formatClock(at)).toBe("09:05");
  const evening = new Date(2026, 10, 1, 21, 40).getTime();
  expect(formatClock(evening)).toBe("21:40");
});

test("the full stamp adds the date and seconds", () => {
  const at = new Date(2026, 10, 1, 9, 5, 7).getTime();
  expect(formatDateTime(at)).toBe("2026年11月1日 09:05:07");
});
