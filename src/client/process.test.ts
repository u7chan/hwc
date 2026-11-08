import { expect, test } from "bun:test";
import type { PaneState } from "../server/herdr/state";
import { commandName, mergeProcesses, paneTabName, processPollAllowed } from "./process";

const shell: PaneState = {
  id: "w1:p2",
  title: null,
  label: "shell",
  agent: null,
  agentStatus: "unknown",
  focused: false,
  chat: false,
};

const running = { running: true, command: "bun --watch src/server.ts" };

test("a shell tab shows the command while it runs", () => {
  expect(paneTabName(shell, running)).toBe("bun");
});

// タブ 1 つで画面幅を埋めないよう、引数は名前には使わない。
test("the tab name is the program, not the whole command line", () => {
  expect(commandName("bun --watch src/server.ts")).toBe("bun");
  expect(commandName("/usr/local/bin/python3 -m http.server")).toBe("python3");
  expect(commandName("  npm   run dev  ")).toBe("npm");
  expect(commandName("")).toBe("");
});

test("a shell tab goes back to its name when the command ends", () => {
  expect(paneTabName(shell, { running: false, command: null })).toBe("shell");
  expect(paneTabName(shell, null)).toBe("shell");
});

test("a command without a readable command line keeps the name", () => {
  expect(paneTabName(shell, { running: true, command: null })).toBe("shell");
});

test("an agent pane keeps its name while a command runs", () => {
  expect(paneTabName({ ...shell, agent: "pi" }, { running: true, command: "pi" })).toBe("shell");
});

test("a hidden document does not poll", () => {
  expect(processPollAllowed("hidden")).toBe(false);
  expect(processPollAllowed("visible")).toBe(true);
});

test("the previous map is reused when nothing changed", () => {
  const before = new Map([[shell.id, { running: false, command: null }]]);
  expect(mergeProcesses(before, [[shell.id, { running: false, command: null }]])).toBe(before);
});

test("a pane that could not be read keeps its last value", () => {
  const before = new Map([[shell.id, running]]);
  expect(mergeProcesses(before, [[shell.id, null]])).toBe(before);
});

test("a changed command replaces the entry", () => {
  const before = new Map([[shell.id, { running: false, command: null }]]);
  const next = mergeProcesses(before, [[shell.id, running]]);
  expect(next).not.toBe(before);
  expect(next.get(shell.id)).toEqual(running);
});
