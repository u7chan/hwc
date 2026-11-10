import { expect, test } from "bun:test";
import {
  type AppState,
  NO_TIMES,
  type PaneState,
  type WorkspaceState,
} from "../server/herdr/state";
import { faviconHref, faviconStatus, faviconSvg } from "./favicon";

function pane(id: string, agent: string | null, agentStatus: PaneState["agentStatus"]): PaneState {
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

function workspace(id: string, panes: readonly PaneState[]): WorkspaceState {
  return {
    id,
    label: id,
    agentStatus: "unknown",
    focused: false,
    worktree: null,
    tabs: [
      {
        id: `${id}:t1`,
        label: "1",
        agentStatus: "unknown",
        focused: false,
        panes: [...panes],
      },
    ],
  };
}

function app(...workspaces: WorkspaceState[]): AppState {
  return {
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
    workspaces,
    times: NO_TIMES,
  };
}

test("a question anywhere wins over work and completion", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi", "done"), pane("w1:p2", "codex", "working")]),
    workspace("w2", [pane("w2:p1", "claude", "blocked")]),
  );

  expect(faviconStatus(state)).toBe("blocked");
});

test("a completed parent wins over other working agents", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi", "done"), pane("w1:p2", "codex", "working")]),
  );

  // 親が終わったスペースを見つけたいので、子の working では黄に落とさない。
  expect(faviconStatus(state)).toBe("done");
});

test("done children do not complete a parent", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi", "idle"), pane("w1:p2", "codex", "done")]));

  expect(faviconStatus(state)).toBeNull();
});

test("working appears only when no parent is done and no one is blocked", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi", "idle"), pane("w1:p2", "codex", "working")]),
  );

  expect(faviconStatus(state)).toBe("working");
});

test("no agent at all means no dot", () => {
  expect(faviconStatus(app(workspace("w1", [pane("w1:p1", null, "idle")])))).toBeNull();
});

test("the icon keeps a transparent edge and one status dot", () => {
  const svg = faviconSvg("working");

  expect(svg).toContain('viewBox="-1 -1 26 26"');
  expect(svg).toContain('fill="#f5c542"');
  expect(svg.match(/<circle/g)?.length).toBe(1);
});

test("the dot color follows the state", () => {
  expect(faviconSvg("blocked")).toContain('fill="#e5484d"');
  expect(faviconSvg("done")).toContain('fill="#4cc9f0"');
});

test("no status returns the static icon and a status uses a data URL", () => {
  expect(faviconHref(null, "/favicon.svg")).toBe("/favicon.svg");
  expect(faviconHref("done", "/favicon.svg")).toStartWith("data:image/svg+xml,");
  // # を URL に残すとフラグメントとして切れる。エンコードした色だけを入れる。
  expect(faviconHref("done", "/favicon.svg")).toContain("%234cc9f0");
});
