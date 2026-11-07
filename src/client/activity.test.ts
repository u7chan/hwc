import { expect, test } from "bun:test";
import { ACTIVITY_POLL_MS } from "./api";
import {
  activityLabel,
  activityLoadAllowed,
  activityPollDelay,
  activitySnippet,
  selectActivity,
} from "./activity";
import type { PaneActivity } from "../shared/activity";

const base: PaneActivity = { phase: "thinking", text: "", tool: null, tools: 1, at: 0 };

test("names each phase in one short line", () => {
  expect(activityLabel({ ...base, phase: "waiting" })).toBe("応答を待っています");
  expect(activityLabel({ ...base, phase: "thinking" })).toBe("考えています");
  expect(activityLabel({ ...base, phase: "writing" })).toBe("回答を書いています");
  expect(activityLabel({ ...base, phase: "compacting" })).toBe("会話を圧縮しています");
  expect(activityLabel({ ...base, phase: "waiting-user" })).toBe("端末の入力を待っています");
  // 引数の生成中は一瞬しか続かないので、ラベルを出さない。
  expect(activityLabel({ ...base, phase: "tool-call" })).toBeNull();
});

test("a running tool names the tool and the parallel count", () => {
  expect(activityLabel({ ...base, phase: "tool", tool: "bash", tools: 1 })).toBe("bash を実行中");
  expect(activityLabel({ ...base, phase: "tool", tool: "read", tools: 3 })).toBe(
    "read など 3 件を実行中",
  );
  expect(activityLabel({ ...base, phase: "tool", tool: null, tools: 1 })).toBe(
    "ツールを実行しています",
  );
});

test("the snippet keeps the newest two non-empty lines", () => {
  expect(activitySnippet("one\ntwo\nthree")).toBe("two\nthree");
  expect(activitySnippet("one\n\n  two  \n\n")).toBe("one\ntwo");
  expect(activitySnippet("")).toBe("");
  expect(activitySnippet("\n \n")).toBe("");
});

test("the snippet marks a cut at the front and keeps the tail", () => {
  const snippet = activitySnippet("あ".repeat(200), 2, 10);
  expect(Array.from(snippet)).toHaveLength(11);
  expect(snippet.startsWith("…")).toBe(true);
  expect(snippet.endsWith("あ")).toBe(true);
});

test("polls only while working and visible", () => {
  expect(activityPollDelay("working", "visible")).toBe(ACTIVITY_POLL_MS);
  expect(activityPollDelay("working", "hidden")).toBeNull();
  expect(activityPollDelay("idle", "visible")).toBeNull();
  expect(activityPollDelay("unknown", "visible")).toBeNull();
});

test("never fetches while hidden or while the run is over", () => {
  expect(activityLoadAllowed("working", "visible")).toBe(true);
  // 隠れた状態で開いたとき・可視復帰したときも、working でなければ読まない。
  expect(activityLoadAllowed("working", "hidden")).toBe(false);
  expect(activityLoadAllowed("idle", "visible")).toBe(false);
  expect(activityLoadAllowed("blocked", "visible")).toBe(false);
});

test("a disabled hook does not return the previous pane's activity", () => {
  const activity: PaneActivity = { ...base, text: "前のターン", at: 1 };
  expect(selectActivity(true, "w1:p1", { paneId: "w1:p1", activity })).toEqual(activity);
  // 同じペイン id でも、無効化（codex に変わった等）や別ペインなら出さない。
  expect(selectActivity(false, "w1:p1", { paneId: "w1:p1", activity })).toBeNull();
  expect(selectActivity(true, "w1:p2", { paneId: "w1:p1", activity })).toBeNull();
  expect(selectActivity(true, "w1:p1", null)).toBeNull();
});
