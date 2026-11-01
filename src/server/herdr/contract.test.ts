import { expect, test } from "bun:test";
import { type HerdrSnapshot, parsePaneRead, parseSnapshot } from "./contract";

const snapshot: HerdrSnapshot = {
  focused_workspace_id: "w1",
  focused_tab_id: "w1:t1",
  focused_pane_id: "w1:p2",
  workspaces: [{ workspace_id: "w1", label: "hwc", agent_status: "working", focused: true }],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "main", agent_status: "working", focused: true },
  ],
  panes: [
    {
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t1",
      agent_status: "working",
      focused: true,
    },
  ],
  agents: [{ pane_id: "w1:p2", agent: "pi", terminal_title_stripped: "π - hwc" }],
};

test("parseSnapshot keeps the fields the state needs", () => {
  expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
});

test("parseSnapshot accepts a snapshot without the optional collections", () => {
  expect(parseSnapshot({ focused_workspace_id: "w1" })).toMatchObject({
    focused_workspace_id: "w1",
    focused_tab_id: null,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
  });
});

test("parseSnapshot maps an unknown agent status to unknown", () => {
  const parsed = parseSnapshot({
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "sleeping" }],
  });

  expect(parsed.panes?.[0]?.agent_status).toBe("unknown");
});

test("parseSnapshot rejects a payload that is not a snapshot", () => {
  expect(() => parseSnapshot(null)).toThrow("must be an object");
  expect(() => parseSnapshot([{ workspaces: [] }])).toThrow("must be an object");
  expect(() => parseSnapshot({ workspaces: "w1" })).toThrow("must be an array");
});

test("parseSnapshot rejects a record without its id", () => {
  expect(() => parseSnapshot({ workspaces: [{ label: "hwc" }] })).toThrow("workspace_id");
  expect(() => parseSnapshot({ tabs: [{ tab_id: "w1:t1" }] })).toThrow("tab.workspace_id");
  expect(() => parseSnapshot({ panes: [{ pane_id: "w1:p1", workspace_id: "w1" }] })).toThrow(
    "pane.tab_id",
  );
});

function paneRead(overrides: Record<string, unknown> = {}, read: Record<string, unknown> = {}) {
  return {
    type: "pane_read",
    ...overrides,
    read: {
      pane_id: "w1:p1",
      text: "hello\n",
      truncated: true,
      revision: 7,
      format: "text",
      source: "recent",
      ...read,
    },
  };
}

test("parsePaneRead keeps the output text and how much was cut off", () => {
  expect(parsePaneRead(paneRead(), "w1:p1")).toEqual({
    paneId: "w1:p1",
    text: "hello\n",
    truncated: true,
    revision: 7,
  });
});

test("parsePaneRead rejects a result without the read record", () => {
  expect(() => parsePaneRead({ type: "pane_read" }, "w1:p1")).toThrow("pane_read.read");
  expect(() => parsePaneRead(paneRead({}, { text: 1 }), "w1:p1")).toThrow(
    "pane_read: text must be a string",
  );
  expect(() => parsePaneRead(paneRead({}, { truncated: "no" }), "w1:p1")).toThrow(
    "pane_read: truncated must be a boolean",
  );
});

test("parsePaneRead rejects a revision that is not a non-negative integer", () => {
  for (const revision of [null, -1, 1.5, Number.NaN, "7"]) {
    expect(() => parsePaneRead(paneRead({}, { revision }), "w1:p1")).toThrow(
      "pane_read: revision must be a non-negative integer",
    );
  }
});

test("parsePaneRead rejects another pane than the one that was asked for", () => {
  expect(() => parsePaneRead(paneRead(), "w1:p9")).toThrow("pane_read: pane_id must be w1:p9");
});

test("parsePaneRead rejects a result that is not a pane read", () => {
  expect(() => parsePaneRead({ type: "ok" }, "w1:p1")).toThrow(
    "pane_read: type must be pane_read, got ok",
  );
  expect(() => parsePaneRead(null, "w1:p1")).toThrow("pane_read must be an object");
});
