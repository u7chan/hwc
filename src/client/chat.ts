import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatSnapshot } from "../server/chat/contract";
import type { AgentStatus } from "../server/herdr/state";
import { CHAT_POLL_ACTIVE_MS, CHAT_POLL_IDLE_MS, readChat } from "./api";

// 返答が届いている間は短く、動いていない間は長く。隠れている間に読んでも見る人はいない。
export function chatPollDelay(
  status: AgentStatus,
  visibility: DocumentVisibilityState,
): number | null {
  if (visibility === "hidden") return null;
  return status === "working" ? CHAT_POLL_ACTIVE_MS : CHAT_POLL_IDLE_MS;
}

// 打ち切りは失敗ではない。端末出力へも切り替えない。
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "name" in error && (error as { name: unknown }).name === "AbortError";
}

export type PaneBody =
  | { kind: "chat"; snapshot: ChatSnapshot }
  | { kind: "skeleton" }
  | { kind: "output" };

// 会話を持たないペイン、会話を読めない間、要対応で端末を見たい間は端末出力を出す。
export function paneBody(props: {
  chat: boolean;
  blocked: boolean;
  failed: boolean;
  snapshot: ChatSnapshot | null;
}): PaneBody {
  if (!props.chat || props.blocked || props.failed) return { kind: "output" };
  if (props.snapshot === null) return { kind: "skeleton" };
  return { kind: "chat", snapshot: props.snapshot };
}

export type AgentInfo = { model: string | null; effort: string | null };

// どちらも無ければ札を出さない。片方だけ分かるならそれだけ出す。
export function agentInfo(snapshot: ChatSnapshot | null): AgentInfo | null {
  if (snapshot === null) return null;
  if (snapshot.model === null && snapshot.effort === null) return null;
  return { model: snapshot.model, effort: snapshot.effort };
}

// 狭い画面ではモデル名が省略される。触れたときに全体が読めるようにする。
export function agentInfoLabel(info: AgentInfo): string {
  return [info.model, info.effort === null ? null : `effort ${info.effort}`]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

type ChatEntry = { paneId: string; snapshot: ChatSnapshot };

export function usePaneChat(
  paneId: string,
  enabled: boolean,
  status: AgentStatus,
): { snapshot: ChatSnapshot | null; failed: boolean } {
  const [latest, setLatest] = useState<ChatEntry | null>(null);
  // 失敗したペインを覚える。切り替えた直後に前のペインの失敗を出さない。
  const [failedPane, setFailedPane] = useState<string | null>(null);

  // 間隔だけを描画のたびに更新する。effect の依存に入れると、状態が変わるたびに張り直して
  // etag を失い、同じ本文を取り直すことになる。
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!enabled) return;
    const id = paneId;

    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    // 経過は effect の中で持ち回る。304 のときは本文を捨てて、この値を保つ。
    let etag: string | null = null;

    function stop() {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    }

    function schedule() {
      stop();
      const delay = chatPollDelay(statusRef.current, document.visibilityState);
      if (delay !== null) timer = window.setTimeout(() => void load(), delay);
    }

    async function load() {
      stop();
      const current = new AbortController();
      controller = current;
      try {
        const read = await readChat(id, etag, current.signal);
        if (!active) return;
        if (read.kind === "snapshot") {
          etag = read.snapshot.etag;
          setLatest({ paneId: id, snapshot: read.snapshot });
        }
        setFailedPane(read.kind === "unavailable" ? id : null);
      } catch (error) {
        // 隠れたことで打ち切った場合は失敗ではない。
        if (!active || isAbortError(error)) return;
        setFailedPane(id);
      }
      if (active) schedule();
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        stop();
        controller?.abort();
        return;
      }
      void load();
    }

    document.addEventListener("visibilitychange", onVisibility);
    void load();

    return () => {
      active = false;
      stop();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [paneId, enabled]);

  // ペインを切り替えた直後に、前のペインの会話を出さない。
  return {
    snapshot: latest?.paneId === paneId ? latest.snapshot : null,
    failed: failedPane === paneId,
  };
}
