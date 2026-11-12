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

const running = { running: true, command: "bun --watch src/server.ts", ports: [] };

test("a shell tab shows the command while it runs", () => {
  expect(paneTabName(shell, running)).toBe("bun");
});

test("a listening server adds its port to the tab", () => {
  expect(paneTabName(shell, { ...running, ports: [30_000] })).toBe("bun 30000");
  expect(paneTabName(shell, { ...running, ports: [5173, 24_678] })).toBe("bun 5173");
});

// タブ 1 つで画面幅を埋めないよう、引数は名前には使わない。
test("the tab name is the program, not the whole command line", () => {
  expect(commandName("bun --watch src/server.ts")).toBe("bun");
  expect(commandName("/usr/local/bin/python3 -m http.server")).toBe("python3");
  expect(commandName("  npm   run dev  ")).toBe("npm");
  expect(commandName("")).toBe("");
});

test("a shell tab goes back to its name when the command ends", () => {
  expect(paneTabName(shell, { running: false, command: null, ports: [] })).toBe("shell");
  expect(paneTabName(shell, null)).toBe("shell");
});

test("a command without a readable command line keeps the name", () => {
  expect(paneTabName(shell, { running: true, command: null, ports: [] })).toBe("shell");
});

test("an agent pane keeps its name while a command runs", () => {
  expect(
    paneTabName({ ...shell, agent: "pi" }, { running: true, command: "pi", ports: [3000] }),
  ).toBe("shell");
});

test("a hidden document does not poll", () => {
  expect(processPollAllowed("hidden")).toBe(false);
  expect(processPollAllowed("visible")).toBe(true);
});

test("the previous map is reused when nothing changed", () => {
  const before = new Map([[shell.id, { running: false, command: null, ports: [] }]]);
  expect(
    mergeProcesses(before, [[shell.id, { running: false, command: null, ports: [] }]], [shell.id]),
  ).toBe(before);
});

test("a pane that could not be read keeps its last value", () => {
  const before = new Map([[shell.id, running]]);
  expect(mergeProcesses(before, [[shell.id, null]], [shell.id])).toBe(before);
});

// コマンドが動いたまま bind する（python3 -m http.server など）と、running と command は
// 変わらず ports だけが現れる。ここを取りこぼすとタブにポートが出ない。
test("a port that appears while the command keeps running replaces the entry", () => {
  const before = new Map([[shell.id, running]]);
  const withPort = { ...running, ports: [8000] };
  const next = mergeProcesses(before, [[shell.id, withPort]], [shell.id]);
  expect(next).not.toBe(before);
  expect(next.get(shell.id)).toEqual(withPort);
  expect(mergeProcesses(next, [[shell.id, withPort]], [shell.id])).toBe(next);
  expect(mergeProcesses(next, [[shell.id, { ...withPort, ports: [8001] }]], [shell.id])).not.toBe(
    next,
  );
});

test("a changed command replaces the entry", () => {
  const before = new Map([[shell.id, { running: false, command: null, ports: [] }]]);
  const next = mergeProcesses(before, [[shell.id, running]], [shell.id]);
  expect(next).not.toBe(before);
  expect(next.get(shell.id)).toEqual(running);
});

// ポーリング対象から外れたペインを残すと、履歴のシェルのタブ名が止んだコマンドのまま固定される。
test("panes no longer polled are dropped from the map", () => {
  const other = "w1:p3";
  const before = new Map([
    [shell.id, running],
    [other, { running: true, command: "npm run dev", ports: [] }],
  ]);

  const next = mergeProcesses(before, [[shell.id, null]], [shell.id]);
  expect([...next.keys()]).toEqual([shell.id]);

  const same = mergeProcesses(before, [], [shell.id, other]);
  expect(same).toBe(before);
});
