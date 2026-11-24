import { expect, test } from "bun:test";
import { type AppState, NO_TIMES, type PaneState } from "../../server/herdr/state";
import {
  recordLaunch,
  recordLaunchResult,
  recordRetry,
  withoutLaunch,
  withoutSettledLaunches,
} from "./launch";
import { STARTING_SETTLE_MS, type PaneLaunch } from "../starting";

const AT = 1_000;

const OPUS = { provider: "anthropic", id: "opus" };

const pane = (overrides: Partial<PaneState> = {}): PaneState => ({
  id: "w1:p2",
  title: null,
  label: null,
  agent: "pi",
  agentStatus: "idle",
  focused: false,
  chat: true,
  ...overrides,
});

const state = (panes: PaneState[]): AppState => ({
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: panes[0]?.id ?? null,
  times: NO_TIMES,
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "idle",
      focused: true,
      worktree: null,
      path: "/home/example/hwc",
      branch: "main",
      sync: null,
      tabs: [{ id: "w1:t1", label: "main", agentStatus: "idle", focused: true, panes }],
    },
  ],
});

const launch = (overrides: Partial<PaneLaunch> = {}): PaneLaunch => ({
  paneId: "w1:p2",
  at: AT,
  agent: "pi",
  model: null,
  effort: null,
  request: "started",
  waitForShell: true,
  error: null,
  ...overrides,
});

const recorded = (items: PaneLaunch[]): ReadonlyMap<string, PaneLaunch> =>
  new Map(items.map((item) => [item.paneId, item]));

// ダイアログで選んだ指定だけを預かり、起動したかはスナップショットに決めさせる。
test("a launch records the chosen agent and waits for the pane to appear", () => {
  const next = recordLaunch(
    new Map(),
    "w1:p2",
    { agent: "pi", model: OPUS, effort: "high", waitForShell: true },
    AT,
  );
  expect(next.get("w1:p2")).toEqual({
    paneId: "w1:p2",
    at: AT,
    agent: "pi",
    model: OPUS,
    effort: "high",
    request: "waiting",
    waitForShell: true,
    error: null,
  });
});

// 起動せずにダイアログを閉じたときは、預かった記録を残さない。
test("closing the dialog without launching drops the record", () => {
  const current = recorded([launch({ request: "waiting" })]);
  expect(recordLaunch(current, "w1:p2", null, AT).has("w1:p2")).toBe(false);
  expect(recordLaunch(new Map(), "w1:p2", null, AT).size).toBe(0);
});

// 起動要求が通ったら、あとはスナップショットが起動完了を決める。時刻は応答の時刻に進める。
test("a started launch keeps waiting for the snapshot with the reply time", () => {
  const pending = launch({ request: "waiting" });
  const next = recordLaunchResult(recorded([pending]), pending, { ok: true }, AT + 500);
  expect(next.get("w1:p2")?.request).toBe("started");
  expect(next.get("w1:p2")?.at).toBe(AT + 500);
  expect(next.get("w1:p2")?.error).toBeNull();
});

// 既にエージェントが動いているペインでも、待ちは続ける。起動したかはスナップショットが決める。
test("a pane that is already not a shell keeps waiting", () => {
  const pending = launch({ request: "waiting" });
  const next = recordLaunchResult(
    recorded([pending]),
    pending,
    { ok: false, error: "pane_not_shell" },
    AT,
  );
  expect(next.get("w1:p2")?.request).toBe("started");
  expect(next.get("w1:p2")?.error).toBeNull();
});

test("a failed launch records why it failed and can be retried", () => {
  const pending = launch({ request: "waiting" });
  const failed = recordLaunchResult(
    recorded([pending]),
    pending,
    { ok: false, error: "pane_busy" },
    AT,
  );
  expect(failed.get("w1:p2")?.request).toBe("failed");
  expect(failed.get("w1:p2")?.error).toBe("pane_busy");
});

// 再試行で記録が置き換わっていたら、遅れて返った前の要求の結果で上書きしない。
test("a late reply does not overwrite the record the retry made", () => {
  const pending = launch({ request: "waiting" });
  const retried = recordRetry(recorded([pending]), "w1:p2", AT + 100);
  const next = recordLaunchResult(retried, pending, { ok: true }, AT + 200);
  expect(next).toBe(retried);
  expect(next.get("w1:p2")?.request).toBe("waiting");
});

// 再試行は同じ指定を預け直す。時刻は新しい要求の時刻に進める。
test("a retry asks again with the same choices", () => {
  const failed = launch({ request: "failed", error: "pane_busy", model: OPUS, effort: "high" });
  const next = recordRetry(recorded([failed]), "w1:p2", AT + 100);
  expect(next.get("w1:p2")).toEqual({
    paneId: "w1:p2",
    at: AT + 100,
    agent: "pi",
    model: OPUS,
    effort: "high",
    request: "waiting",
    waitForShell: true,
    error: null,
  });
});

// 起動を諦めた後は再試行できない。記録の無いペインはそのまま。
test("a retry without a record leaves the records alone", () => {
  const current = recorded([launch()]);
  expect(recordRetry(current, "w1:p9", AT)).toBe(current);
  expect(recordRetry(new Map(), "w1:p2", AT).size).toBe(0);
});

// シェルとして使うと、起動待ちの表示も入力欄の形も戻る。
test("using the shell drops the record", () => {
  const current = recorded([launch({ request: "failed", error: "timeout" })]);
  expect(withoutLaunch(current, "w1:p2").size).toBe(0);
  expect(withoutLaunch(new Map(), "w1:p2").size).toBe(0);
});

// 起動したかはスナップショットが決める。起動完了を示したら記録は捨て、以後の表示に
// 「起動を確認できませんでした」を残さない。
test("a record is dropped once the snapshot shows the agent is up", () => {
  const settled = launch({ request: "started" });
  const current = recorded([settled]);
  const shown = state([pane({ agent: "pi", chat: true })]);
  expect(withoutSettledLaunches(current, shown, AT + STARTING_SETTLE_MS - 1).has("w1:p2")).toBe(
    true,
  );
  expect(withoutSettledLaunches(current, shown, AT + STARTING_SETTLE_MS).size).toBe(0);
});

// 新しいペインは、応答より先に記録だけができていることがある。スナップショットに現れるまで残す。
test("a waiting record stays while its pane is not in the snapshot yet", () => {
  const waiting = launch({ request: "waiting" });
  expect(withoutSettledLaunches(recorded([waiting]), state([]), AT).has("w1:p2")).toBe(true);
});

// 応答済みの記録は、ペインがスナップショットから消えたら捨てる。
test("a replied record is dropped when its pane is gone", () => {
  const current = recorded([launch({ request: "failed", error: "pane_busy" })]);
  expect(withoutSettledLaunches(current, state([]), AT).size).toBe(0);
});

// 起動待ちの間は記録を残す。まだ起動していないことを表示に出し続ける。
test("a launching record stays until the launch settles", () => {
  const current = recorded([launch({ request: "waiting" })]);
  const shell = state([pane({ agent: null, chat: false })]);
  expect(withoutSettledLaunches(current, shell, AT).has("w1:p2")).toBe(true);
});

// 他のペインの記録は、関係の無いペインが起動完了しても残す。
test("records for other panes are left alone", () => {
  const other = launch({ paneId: "w1:p3", request: "waiting" });
  const current = recorded([launch({ request: "started" }), other]);
  const shown = state([pane(), pane({ id: "w1:p3", agent: null, chat: false })]);
  const next = withoutSettledLaunches(current, shown, AT + STARTING_SETTLE_MS);
  expect(next.has("w1:p2")).toBe(false);
  expect(next.get("w1:p3")).toBe(other);
});
