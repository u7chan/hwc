import { expect, test } from "bun:test";
import { type PaneState, type WorkspaceState } from "../server/herdr/state";
import { parentPaneOf } from "./parent-pane";

function parentPane(
  id: string,
  agent: string | null,
  agentStatus: PaneState["agentStatus"] = "idle",
): PaneState {
  return {
    id,
    title: null,
    label: null,
    agent,
    agentStatus,
    focused: false,
    chat: false,
  };
}

function parentWorkspace(id: string, tabs: readonly (readonly PaneState[])[]): WorkspaceState {
  return {
    id,
    label: id,
    agentStatus: "unknown",
    focused: false,
    worktree: null,
    tabs: tabs.map((panes, index) => ({
      id: `${id}:t${index + 1}`,
      label: String(index + 1),
      agentStatus: "unknown" as const,
      focused: false,
      panes: [...panes],
    })),
  };
}

test("the parent is the first agent pane from the left", () => {
  const workspace = parentWorkspace("w1", [
    [
      parentPane("w1:p1", null, "idle"),
      parentPane("w1:p2", "pi", "done"),
      parentPane("w1:p3", "codex", "idle"),
    ],
    [parentPane("w1:p4", "pi", "working")],
  ]);

  // シェルは飛ばし、左端のタブの先頭から見る。別タブの先頭エージェントは親にしない。
  expect(parentPaneOf(workspace)?.id).toBe("w1:p2");
});

test("a workspace without agents has no parent", () => {
  const workspace = parentWorkspace("w1", [[parentPane("w1:p1", null, "idle")]]);
  expect(parentPaneOf(workspace)).toBeNull();
});

test("the parent search skips a tab with no agents", () => {
  const workspace = parentWorkspace("w1", [
    [parentPane("w1:p1", null, "idle")],
    [parentPane("w1:p2", "pi", "done")],
  ]);
  expect(parentPaneOf(workspace)?.id).toBe("w1:p2");
});
