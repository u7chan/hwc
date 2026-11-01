import { expect, test } from "bun:test";
import type { AppState } from "../server/herdr/state";
import {
  countPanes,
  countWorkspacePanes,
  findPane,
  findPaneContext,
  initialExpanded,
  statusLabel,
  statusTone,
} from "./select";

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
      tabs: [
        {
          id: "w1:t1",
          label: "main",
          agentStatus: "working",
          focused: true,
          panes: [
            { id: "w1:p1", title: "π - hwc", agent: "pi", agentStatus: "working", focused: true },
            { id: "w1:p2", title: null, agent: null, agentStatus: "unknown", focused: false },
          ],
        },
        {
          id: "w1:t2",
          label: "verify",
          agentStatus: "idle",
          focused: false,
          panes: [{ id: "w1:p3", title: "bash", agent: null, agentStatus: "idle", focused: false }],
        },
      ],
    },
    {
      id: "w2",
      label: "hwc-verify",
      agentStatus: "blocked",
      focused: false,
      tabs: [
        {
          id: "w2:t1",
          label: "main",
          agentStatus: "blocked",
          focused: false,
          panes: [
            { id: "w2:p1", title: "bash", agent: null, agentStatus: "blocked", focused: false },
          ],
        },
      ],
    },
  ],
};

test("findPane resolves a pane from its id", () => {
  expect(findPane(state, "w1:p2")?.id).toBe("w1:p2");
  expect(findPane(state, "w9:p9")).toBeNull();
  expect(findPane(state, null)).toBeNull();
});

test("findPaneContext names the workspace and tab of a pane", () => {
  expect(findPaneContext(state, "w2:p1")).toEqual({
    workspaceLabel: "hwc-verify",
    tabLabel: "main",
  });
  expect(findPaneContext(state, "w9:p9")).toBeNull();
});

test("the counts follow the nesting", () => {
  expect(countPanes(state)).toBe(4);
  expect(countWorkspacePanes("w1", state)).toBe(3);
});

test("status maps to a tone and a label", () => {
  expect(statusTone("working")).toBe("active");
  expect(statusTone("blocked")).toBe("attention");
  expect(statusTone("done")).toBe("success");
  expect(statusTone("idle")).toBe("neutral");
  expect(statusTone("unknown")).toBe("neutral");

  expect(statusLabel("working")).toBe("実行中");
  expect(statusLabel("blocked")).toBe("要対応");
  expect(statusLabel("done")).toBe("完了");
  expect(statusLabel("idle")).toBe("待機");
  expect(statusLabel("unknown")).toBe("不明");
});

test("only the focused workspace starts expanded", () => {
  expect([...initialExpanded(state)]).toEqual(["w1"]);
});
