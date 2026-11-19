import { expect, test } from "bun:test";
import { ACTIVITY_POLL_MS } from "./api";
import {
  ACTIVITY_HOLD_MS,
  activityLabel,
  activityLoadAllowed,
  activityPollDelay,
  activitySnippet,
  activityStep,
  formatTokPerSecond,
  nextActivityHold,
  selectActivity,
  showActivityFrame,
} from "./activity";
import type { PaneActivity } from "../shared/activity";

const base: PaneActivity = {
  phase: "thinking",
  text: "",
  tool: null,
  tools: 1,
  tokPerSecond: null,
  at: 0,
};

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

test("formats the live rate like the TUI footer", () => {
  expect(formatTokPerSecond(4.64)).toBe("4.6");
  expect(formatTokPerSecond(42.34)).toBe("42.3");
  expect(formatTokPerSecond(100)).toBe("100");
  expect(formatTokPerSecond(158.4)).toBe("158");
  expect(formatTokPerSecond(0)).toBeNull();
  expect(formatTokPerSecond(Number.NaN)).toBeNull();
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

test("the next run loads again after an idle turn", () => {
  // 1 ターン目が終わったら idle を消費し、2 ターン目の working を新しい変化として扱う。
  const ended = activityStep("working", "idle", true);
  expect(ended).toEqual({ last: "idle", fetch: false, clear: true });
  const restarted = activityStep(ended.last, "working", true);
  expect(restarted).toEqual({ last: "working", fetch: true, clear: false });
  // 同じ状態の再通知では読まない。
  expect(activityStep("working", "working", true)).toEqual({
    last: "working",
    fetch: false,
    clear: false,
  });
  // 隠れている間に始まっても読まない。可視復帰で読む。
  expect(activityStep("idle", "working", false)).toEqual({
    last: "working",
    fetch: false,
    clear: true,
  });
  // blocked でもターンの表示は捨てる。戻ったときに同じターンとして取り直す。
  expect(activityStep("working", "blocked", true)).toEqual({
    last: "blocked",
    fetch: false,
    clear: true,
  });
});

test("the two lines of a tool stay together in the snippet", () => {
  // 対象 60 + 改行 + 方向 90 は、末尾 2 行・160 文字の枠に収まる（ADR 0099）。
  const text = `${"対象".repeat(30)}\n${"方向".repeat(45)}`;
  expect(activitySnippet(text)).toBe(text);
  expect(activitySnippet(text).split("\n")).toHaveLength(2);
});

test("Claude keeps the last activity through a null while the turn is running", () => {
  const activity: PaneActivity = { ...base, phase: "tool", text: "quickstart.md\n手順", at: 1_000 };
  const hold = { paneId: "w1:p1", session: "ses_1", activity, at: 1_000 };
  const empty = { activity: null, session: "ses_1" };

  // 段階が取れない間は、直前の値をそのまま出す。
  expect(nextActivityHold(true, hold, "w1:p1", empty, 5_000)).toBe(hold);
  // 最後に非 null を得てから 10 秒経ったら捨てる。
  expect(nextActivityHold(true, hold, "w1:p1", empty, 1_000 + ACTIVITY_HOLD_MS)).toBeNull();
  // pi は null をそのまま出し、ペインの移動と session の変更でも捨てる。
  expect(nextActivityHold(false, hold, "w1:p1", empty, 2_000)).toBeNull();
  expect(nextActivityHold(true, hold, "w1:p2", empty, 2_000)).toBeNull();
  expect(
    nextActivityHold(true, hold, "w1:p1", { activity: null, session: "ses_2" }, 2_000),
  ).toBeNull();
  expect(nextActivityHold(true, null, "w1:p1", empty, 2_000)).toBeNull();

  const next: PaneActivity = { ...base, phase: "thinking", text: "方向", at: 2_000 };
  expect(
    nextActivityHold(true, hold, "w1:p1", { activity: next, session: "ses_1" }, 2_000),
  ).toEqual({ paneId: "w1:p1", session: "ses_1", activity: next, at: 2_000 });
});

test("Claude reserves the second line before the first activity arrives", () => {
  expect(showActivityFrame("claude", false, null)).toBe(true);
  // 低いセルは会話へ高さを回すので、枠を出さない。
  expect(showActivityFrame("claude", true, null)).toBe(false);
  // pi は activity が届いてから枠を出す。
  expect(showActivityFrame("pi", false, null)).toBe(false);
  expect(showActivityFrame("pi", false, base)).toBe(true);
  expect(showActivityFrame("pi", true, base)).toBe(false);
  expect(showActivityFrame(null, false, null)).toBe(false);
});

test("a disabled hook does not return the previous pane's activity", () => {
  const activity: PaneActivity = { ...base, text: "前のターン", at: 1 };
  const hold = { paneId: "w1:p1", session: "ses_1", activity, at: 1 };
  expect(selectActivity(true, "w1:p1", hold)).toEqual(activity);
  // 同じペイン id でも、無効化（codex に変わった等）や別ペインなら出さない。
  expect(selectActivity(false, "w1:p1", hold)).toBeNull();
  expect(selectActivity(true, "w1:p2", hold)).toBeNull();
  expect(selectActivity(true, "w1:p1", null)).toBeNull();
});
