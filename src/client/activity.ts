import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentStatus } from "../server/herdr/state";
import type { PaneActivity } from "../shared/activity";
import { ACTIVITY_POLL_MS, readActivity } from "./api";
import { isAbortError } from "./chat";

// 末尾 2 行だけ出す。積み上げないので、行数は固定して高さを揺らさない。
export const ACTIVITY_SNIPPET_LINES = 2;
export const ACTIVITY_SNIPPET_CHARS = 160;

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
  entry: ActivityEntry | null,
): PaneActivity | null {
  return enabled && entry !== null && entry.paneId === paneId ? entry.activity : null;
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

// sidecar はペインごとに 1 つ。古いペインの値を出さないため、paneId も一緒に持つ。
type ActivityEntry = { paneId: string; activity: PaneActivity | null };

export function usePaneActivity(
  paneId: string,
  enabled: boolean,
  status: AgentStatus,
): PaneActivity | null {
  const [latest, setLatest] = useState<ActivityEntry | null>(null);

  // 間隔の判断だけを描画のたびに更新する。effect の依存に入れると張り直しになる。
  const statusRef = useRef(status);
  statusRef.current = status;
  const lastStatus = useRef(status);
  const nudge = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const id = paneId;

    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    function stop() {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    }

    function schedule() {
      stop();
      const delay = activityPollDelay(statusRef.current, document.visibilityState);
      lastStatus.current = statusRef.current;
      if (delay !== null) timer = window.setTimeout(() => void load(), delay);
    }

    async function load() {
      stop();
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const activity = await readActivity(id, current.signal);
        if (!active || current.signal.aborted) return;
        setLatest({ paneId: id, activity });
      } catch (error) {
        // 失敗した sidecar を出し続けない。会話の表示には影響させない。
        if (!active || isAbortError(error)) return;
        setLatest({ paneId: id, activity: null });
      } finally {
        if (controller === current) controller = null;
      }
      if (active) schedule();
    }

    // 実行中でなくなったら、取得を待たずにその場で消す。idle の sidecar は残骸。
    function clear() {
      stop();
      controller?.abort();
      setLatest({ paneId: id, activity: null });
    }

    // 実行が始まったら予約を待たずに読み、終わったらその場で消す。
    function onStatusChange() {
      const step = activityStep(
        lastStatus.current,
        statusRef.current,
        document.visibilityState !== "hidden",
      );
      lastStatus.current = step.last;
      if (step.fetch) void load();
      else if (step.clear) clear();
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        stop();
        controller?.abort();
        return;
      }
      if (!activityLoadAllowed(statusRef.current, document.visibilityState)) {
        clear();
        return;
      }
      void load();
    }

    nudge.current = onStatusChange;
    lastStatus.current = statusRef.current;
    document.addEventListener("visibilitychange", onVisibility);
    // 隠れた状態で開いたときも読まない。見えるようになったときの 1 回で追いつく。
    if (activityLoadAllowed(statusRef.current, document.visibilityState)) void load();

    return () => {
      active = false;
      nudge.current = null;
      stop();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [paneId, enabled]);

  useEffect(() => {
    nudge.current?.();
  }, [status]);

  return selectActivity(enabled, paneId, latest);
}
