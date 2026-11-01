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

test("parsePaneRead keeps the output text and how much was cut off", () => {
  expect(
    parsePaneRead({
      type: "pane_read",
      read: { text: "hello\n", truncated: true, revision: 7, format: "text", source: "recent" },
    }),
  ).toEqual({ text: "hello\n", truncated: true, revision: 7 });
});

test("parsePaneRead rejects a result without the read record", () => {
  expect(() => parsePaneRead({ type: "pane_read" })).toThrow("pane_read.read");
  expect(() => parsePaneRead({ type: "pane_read", read: { text: 1 } })).toThrow(
    "pane_read.text must be a string",
  );
  expect(() =>
    parsePaneRead({ type: "pane_read", read: { text: "", truncated: "no", revision: 0 } }),
  ).toThrow("pane_read.truncated must be a boolean");
  expect(() =>
    parsePaneRead({ type: "pane_read", read: { text: "", truncated: false, revision: null } }),
  ).toThrow("pane_read.revision must be a number");
});
