import { expect, test } from "bun:test";
import type { AppState, PaneState } from "../server/herdr/state";
import { AGENT_KINDS } from "./agents";
import { paneCloseAction } from "./pane-close";

const pane: PaneState = {
  id: "w1:p1",
  title: null,
  label: null,
  agent: "pi",
  agentStatus: "idle",
  focused: false,
  chat: false,
};

function stateFor(tabs: PaneState[][]): AppState {
  return {
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
    workspaces: [
      {
        id: "w1",
        label: "demo",
        agentStatus: "idle",
        focused: false,
        worktree: null,
        tabs: tabs.map((panes, index) => ({
          id: `w1:t${index + 1}`,
          label: "main",
          agentStatus: "idle",
          focused: false,
          panes,
        })),
      },
    ],
  };
}

test.each(AGENT_KINDS)(
  "the last %s pane exits its agent instead of deleting the space",
  (agent) => {
    expect(paneCloseAction(stateFor([[{ ...pane, agent }]]), pane.id)).toBe("exit");
  },
);

test.each([null, "generic", "unknown"])(
  "the last %s pane is kept without sending input",
  (agent) => {
    expect(paneCloseAction(stateFor([[{ ...pane, agent }]]), pane.id)).toBe("keep");
  },
);

test("panes in another tab count even when the current tab has only one pane", () => {
  expect(
    paneCloseAction(stateFor([[pane], [{ ...pane, id: "w1:p2", agent: null }]]), pane.id),
  ).toBe("close");
});

test("a shell can be closed when its space has another pane", () => {
  expect(
    paneCloseAction(
      stateFor([
        [
          { ...pane, agent: null },
          { ...pane, id: "w1:p2" },
        ],
      ]),
      pane.id,
    ),
  ).toBe("close");
});

test("panes in other spaces do not make the last pane removable", () => {
  const state = stateFor([[pane]]);
  state.workspaces.push({ ...state.workspaces[0]!, id: "w2" });
  expect(paneCloseAction(state, pane.id)).toBe("exit");
});

test("a missing pane has no close action", () => {
  expect(paneCloseAction(stateFor([[pane]]), "w1:p9")).toBeNull();
});
