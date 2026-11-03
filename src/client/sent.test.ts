import { expect, test } from "bun:test";
import type { AgentStatus, AppState, PaneState, WorkspaceState } from "../server/herdr/state";
import { findPaneRow } from "./select";
import { parseSentPanes, recordSent, sentForSave, sentPanes } from "./sent";

function pane(id: string, agent: string | null, agentStatus: AgentStatus = "idle"): PaneState {
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
      { id: `${id}:t1`, label: "1", agentStatus: "unknown", focused: false, panes: [...panes] },
    ],
  };
}

function app(...workspaces: WorkspaceState[]): AppState {
  return { focusedWorkspaceId: null, focusedTabId: null, focusedPaneId: null, workspaces };
}

test("a sent pane is remembered per space", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi"), pane("w1:p2", "claude")]),
    workspace("w2", [pane("w2:p1", "pi")]),
  );

  const first = recordSent(new Map(), findPaneRow(state, "w1:p1"), 1_000);
  const both = recordSent(first, findPaneRow(state, "w2:p1"), 2_000);

  expect([...both]).toEqual([
    ["w1", { paneId: "w1:p1", at: 1_000 }],
    ["w2", { paneId: "w2:p1", at: 2_000 }],
  ]);
});

test("sending again in one space moves the window and leaves the other alone", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi"), pane("w1:p2", "claude")]),
    workspace("w2", [pane("w2:p1", "pi")]),
  );

  const first = recordSent(
    recordSent(new Map(), findPaneRow(state, "w1:p1"), 1_000),
    findPaneRow(state, "w2:p1"),
    2_000,
  );
  const again = recordSent(first, findPaneRow(state, "w1:p2"), 3_000);

  expect(again.size).toBe(2);
  expect(again.get("w1")).toEqual({ paneId: "w1:p2", at: 3_000 });
  expect(again.get("w2")).toEqual({ paneId: "w2:p1", at: 2_000 });
});

test("a shell is never a window", () => {
  const state = app(workspace("w1", [pane("w1:p1", null, "unknown")]));
  const sent = new Map();

  // 次に送る相手が決まらないので、送れても覚えない。
  expect(recordSent(sent, findPaneRow(state, "w1:p1"), 1_000)).toBe(sent);
  expect(recordSent(sent, findPaneRow(state, "w9:p1"), 1_000)).toBe(sent);
  expect(recordSent(sent, null, 1_000)).toBe(sent);
  expect(sentPanes(state, recordSent(sent, findPaneRow(state, "w1:p1"), 1_000))).toEqual([]);
});

test("windows come out newest first, not in the order the keys were written", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi")]),
    workspace("w2", [pane("w2:p1", "pi")]),
    workspace("w3", [pane("w3:p1", "pi")]),
  );
  const sent = new Map([
    ["w1", { paneId: "w1:p1", at: 1_000 }],
    ["w2", { paneId: "w2:p1", at: 3_000 }],
    ["w3", { paneId: "w3:p1", at: 2_000 }],
  ]);

  expect(sentPanes(state, sent).map((row) => row.pane.id)).toEqual(["w2:p1", "w3:p1", "w1:p1"]);
});

test("a blocked pane is not in the window seat, and a waiting one is", () => {
  const state = app(
    workspace("w1", [pane("w1:p1", "pi", "blocked"), pane("w1:p2", "claude", "idle")]),
  );
  const sent = new Map([["w1", { paneId: "w1:p1", at: 1_000 }]]);

  expect(sentPanes(state, sent)).toEqual([]);

  const waited = new Map([["w1", { paneId: "w1:p2", at: 1_000 }]]);
  expect(sentPanes(state, waited).map((row) => row.pane.id)).toEqual(["w1:p2"]);
});

test("a window that points at a pane which is gone is dropped on save", () => {
  const state = app(workspace("w1", [pane("w1:p1", "pi")]));
  const sent = new Map([
    ["w1", { paneId: "w1:p1", at: 1_000 }],
    ["w2", { paneId: "w2:p1", at: 2_000 }],
    ["w3", { paneId: "w1:p1", at: 3_000 }],
  ]);

  // 居ないスペースと、別のスペースのペインを指す記録は残さない。
  expect(sentForSave(state, sent)).toEqual({ w1: { paneId: "w1:p1", at: 1_000 } });
  expect(sentPanes(state, sent).map((row) => row.pane.id)).toEqual(["w1:p1"]);
});

test("a saved window is read back from the device", () => {
  const sent = parseSentPanes(
    '{"w1":{"paneId":"w1:p1","at":1000},"w2":{"paneId":"w2:p1","at":2000}}',
  );

  expect([...sent]).toEqual([
    ["w1", { paneId: "w1:p1", at: 1_000 }],
    ["w2", { paneId: "w2:p1", at: 2_000 }],
  ]);
});

test("a saved window with a broken shape is dropped", () => {
  const raw = JSON.stringify({
    w1: { paneId: "", at: 1_000 },
    w2: { paneId: "w1:p1" },
    w3: { paneId: "w1:p1", at: "1000" },
    w4: null,
    w5: [1_000],
    w6: { paneId: "w1:p1", at: 2_000 },
  });

  expect([...parseSentPanes(raw)]).toEqual([["w6", { paneId: "w1:p1", at: 2_000 }]]);
  expect([...parseSentPanes("not json")]).toEqual([]);
  expect([...parseSentPanes("[1000]")]).toEqual([]);
  expect([...parseSentPanes(null)]).toEqual([]);
});
