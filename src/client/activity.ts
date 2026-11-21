import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentStatus } from "../server/herdr/state";
import type { PaneActivity } from "../shared/activity";
import { ACTIVITY_POLL_MS, type ActivityRead, readActivity } from "./api";
import { startPoll } from "./poll";

// 末尾 2 行だけ出す。積み上げないので、行数は固定して高さを揺らさない。
export const ACTIVITY_SNIPPET_LINES = 2;
export const ACTIVITY_SNIPPET_CHARS = 160;

// Claude の段階はターン中に取れない瞬間がある（新しい prompt がまだ書かれていない・行の
// 形が読めない）。その間だけ直前の値を保つ。最後に非 null を得てから捨てるまで（docs/adr/claude-integration.md）。
export const ACTIVITY_HOLD_MS = 10_000;

// 実行中だけ 1 秒ごとに読む。idle の sidecar は残骸なので読まない。
export function activityPollDelay(
  status: AgentStatus,
  visibility: DocumentVisibilityState,
): number | null {
  if (visibility === "hidden") return null;
  return status === "working" ? ACTIVITY_POLL_MS : null;
}

// 取得してよいかの判断は 1 か所に置く。隠れた直後の初期化や、idle への可視復帰で読まない。
export function activityLoadAllowed(
  status: AgentStatus,
  visibility: DocumentVisibilityState,
): boolean {
  return status === "working" && visibility !== "hidden";
}

// 状態変化の消費。前回の状態を必ず次へ進める。進め忘れると、次のターンの
// working が「同じ状態」に見えて取得が再開しない。
export type ActivityStep = { last: AgentStatus; fetch: boolean; clear: boolean };

export function activityStep(
  previous: AgentStatus,
  next: AgentStatus,
  visible: boolean,
): ActivityStep {
  if (next === previous) return { last: previous, fetch: false, clear: false };
  const allowed = activityLoadAllowed(next, visible ? "visible" : "hidden");
  return { last: next, fetch: allowed, clear: !allowed };
}

// 表示に使う値。無効化・ペイン切替の直後に、前のペインの値を残さない。
export function selectActivity(
  enabled: boolean,
  paneId: string,
  entry: ActivityHold | null,
): PaneActivity | null {
  return enabled && entry !== null && entry.paneId === paneId ? entry.activity : null;
}

// 帯の thinking の枠を出すか。Claude は最初の activity が届く前も 2 行分を空け、段階の
// 切り替わりで帯の高さを動かさない。低いセルは会話へ高さを回すので枠を出さない。hwc 自身の
// /compact は段階ではないので、空の枠を残さない。
export function showActivityFrame(
  agent: string | null,
  compact: boolean,
  activity: PaneActivity | null,
  compacting: boolean,
): boolean {
  if (compact || compacting) return false;
  if (agent === "claude") return true;
  return activity !== null;
}

// TUI の tok-rate と同じ桁感にする。100 以上は整数、それ未満は小数 1 桁。
export function formatTokPerSecond(tokPerSecond: number): string | null {
  if (!Number.isFinite(tokPerSecond) || tokPerSecond <= 0) return null;
  return tokPerSecond >= 100 ? String(Math.round(tokPerSecond)) : tokPerSecond.toFixed(1);
}

// 何をしているかを短く言う。tool-call は引数の生成中で一瞬しか続かないため、ラベルを出さない。
export function activityLabel(activity: PaneActivity): string | null {
  switch (activity.phase) {
    case "waiting":
      return "応答を待っています";
    case "thinking":
      return "考えています";
    case "writing":
      return "回答を書いています";
    case "tool-call":
      return null;
    case "tool":
      if (activity.tool === null) return "ツールを実行しています";
      return activity.tools > 1
        ? `${activity.tool} など ${activity.tools} 件を実行中`
        : `${activity.tool} を実行中`;
    case "compacting":
      return "会話を圧縮しています";
    case "waiting-user":
      return "端末の入力を待っています";
  }
}

// 新しい方（末尾）を残して切る。先頭が切れたことは … で示す。
export function activitySnippet(
  text: string,
  lines = ACTIVITY_SNIPPET_LINES,
  limit = ACTIVITY_SNIPPET_CHARS,
): string {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== "");
  if (rows.length === 0) return "";
  const snippet = rows.slice(-lines).join("\n");
  const characters = Array.from(snippet);
  if (characters.length <= limit) return snippet;
  return `…${characters.slice(-limit).join("")}`;
}

// 保持中の値。ペインごとに 1 つだけ持ち、古いペインの値を出さない。
export type ActivityHold = {
  paneId: string;
  session: string | null;
  activity: PaneActivity;
  // 最後に非 null を得た時刻。
  at: number;
};

// 取得結果から、表示に使う保持値を作る。pi は null をそのまま出し、Claude だけ保つ。
// ターンが終わる・ペインを移る・blocked・session の変更・10 秒の経過で捨てる。
export function nextActivityHold(
  hold: boolean,
  previous: ActivityHold | null,
  paneId: string,
  read: ActivityRead,
  now: number,
): ActivityHold | null {
  if (read.activity !== null) {
    return { paneId, session: read.session, activity: read.activity, at: now };
  }
  if (!hold || previous === null) return null;
  if (previous.paneId !== paneId) return null;
  if (previous.session !== read.session) return null;
  if (now - previous.at >= ACTIVITY_HOLD_MS) return null;
  return previous;
}

export function usePaneActivity(
  paneId: string,
  enabled: boolean,
  status: AgentStatus,
  hold: boolean,
): PaneActivity | null {
  const [latest, setLatest] = useState<ActivityHold | null>(null);

  // 間隔の判断だけを描画のたびに更新する。effect の依存に入れると張り直しになる。
  const statusRef = useRef(status);
  statusRef.current = status;
  const lastStatus = useRef(status);
  const nudge = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const id = paneId;
    lastStatus.current = statusRef.current;

    const poll = startPoll({
      // 予約と同じ瞬間に、予約が前提にした状態を控える。
      delay: () => {
        lastStatus.current = statusRef.current;
        return activityPollDelay(statusRef.current, document.visibilityState);
      },
      // 状態変化の読み直しに追い越された要求は打ち切る。結果は使わない。
      replace: true,
      // 隠れた状態で開いたときも、実行中でないときに可視へ戻ったときも読まない。
      // 実行が始まったときの 1 回で追いつく。
      resume: (poll, reason) => {
        if (activityLoadAllowed(statusRef.current, document.visibilityState)) {
          poll.load();
          return;
        }
        // 可視へ戻ったら、残っている段階を捨てる。idle の sidecar は残骸。
        if (reason === "visible") {
          poll.pause();
          setLatest(null);
        }
      },
      read: (signal) => readActivity(id, signal),
      apply: (read) =>
        setLatest((previous) => nextActivityHold(hold, previous, id, read, Date.now())),
      // 失敗した sidecar を出し続けない。会話の表示には影響させない。
      failed: () =>
        setLatest((previous) =>
          nextActivityHold(
            hold,
            previous,
            id,
            // 取得できなかっただけなので、session は変わっていないものとして扱う。
            { activity: null, session: previous?.session ?? null },
            Date.now(),
          ),
        ),
    });

    // 実行が始まったら予約を待たずに読み、終わったらその場で消す。
    nudge.current = () => {
      const step = activityStep(
        lastStatus.current,
        statusRef.current,
        document.visibilityState !== "hidden",
      );
      lastStatus.current = step.last;
      if (step.fetch) {
        poll.load();
        return;
      }
      if (step.clear) {
        poll.pause();
        setLatest(null);
      }
    };

    return () => {
      nudge.current = null;
      poll.stop();
    };
  }, [paneId, enabled, hold]);

  useEffect(() => {
    nudge.current?.();
  }, [status]);

  return selectActivity(enabled, paneId, latest);
}
