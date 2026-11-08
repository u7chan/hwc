import { expect, test } from "bun:test";
import { IDLE_PANE_PROCESS, parsePaneProcess } from "./panes";

test("a running process keeps its command and ports", () => {
  expect(
    parsePaneProcess({ running: true, command: "bun --watch src/server.ts", ports: [3000, 5173] }),
  ).toEqual({ running: true, command: "bun --watch src/server.ts", ports: [3000, 5173] });
});

test("ports that are not usable are dropped", () => {
  expect(
    parsePaneProcess({ running: true, command: "bun", ports: [0, 70_000, "3000", 3000.5] }),
  ).toEqual({ running: true, command: "bun", ports: [] });
  expect(parsePaneProcess({ running: true, command: "bun" })).toEqual({
    running: true,
    command: "bun",
    ports: [],
  });
});

test("an empty command is null", () => {
  expect(parsePaneProcess({ running: true, command: "", ports: [] })).toEqual({
    running: true,
    command: null,
    ports: [],
  });
});

test("anything that is not a process is idle", () => {
  expect(parsePaneProcess(null)).toBe(IDLE_PANE_PROCESS);
  expect(parsePaneProcess([])).toBe(IDLE_PANE_PROCESS);
  expect(parsePaneProcess("running")).toBe(IDLE_PANE_PROCESS);
  expect(parsePaneProcess({})).toEqual(IDLE_PANE_PROCESS);
});
