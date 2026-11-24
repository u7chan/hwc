import type { ChatSnapshot } from "../../server/chat/contract";
import { parsePaneActivity, type PaneActivity } from "../../shared/activity";
import { client, paneParam } from "../api";
import { toChatSnapshot } from "../chat-decode";

// 実行中は返答が届き続けるので短く、待機中は追記が無いので長く寝かせる。
export const CHAT_POLL_ACTIVE_MS = 2_000;
export const CHAT_POLL_IDLE_MS = 5_000;
// 実行中の段階は 1 秒で十分。thinking の末尾が追いつく程度に短くする。
export const ACTIVITY_POLL_MS = 1_000;

export type ChatRead =
  | { kind: "snapshot"; snapshot: ChatSnapshot }
  | { kind: "unchanged" }
  | { kind: "unavailable" };

// 304 は本文が無いだけで、手元の会話をそのまま使う。それ以外の失敗は、会話を出せない
// 応答として扱い、端末出力へ切り替える。
export function chatOutcome(status: number): ChatRead["kind"] {
  if (status === 304) return "unchanged";
  if (status >= 200 && status < 300) return "snapshot";
  return "unavailable";
}

export async function readChat(
  paneId: string,
  etag: string | null,
  signal?: AbortSignal,
): Promise<ChatRead> {
  const headers: Record<string, string> = {};
  // 手元に会話が無いのに 304 を返させない。条件は持っているときだけ付ける。
  if (etag !== null) headers["if-none-match"] = `"${etag}"`;
  const response = await client.api.panes[":id"].chat.$get(paneParam(paneId), {
    headers,
    init: { signal },
  });
  const outcome = chatOutcome(response.status);
  if (outcome === "unchanged") return { kind: "unchanged" };
  if (outcome === "unavailable") return { kind: "unavailable" };
  const snapshot = toChatSnapshot(await response.json());
  if (snapshot === null) return { kind: "unavailable" };
  return { kind: "snapshot", snapshot };
}

// 会話とは別の使い捨ての取得口。ETag も持たず、取れなければ null に畳む。
export type ActivityRead = { activity: PaneActivity | null; session: string | null };

export async function readActivity(paneId: string, signal?: AbortSignal): Promise<ActivityRead> {
  const response = await client.api.panes[":id"].activity.$get(paneParam(paneId), {
    init: { signal },
  });
  if (!response.ok) throw new Error(`activity: ${response.status}`);
  const body = (await response.json()) as { activity?: unknown; session?: unknown };
  return {
    activity: parsePaneActivity(body.activity),
    session: parseActivitySession(body.session),
  };
}

// 保持中の値と比べるだけの id。空文字と制御文字は捨てる。
export function parseActivitySession(value: unknown): string | null {
  return typeof value === "string" && value !== "" && !/\p{Cc}/u.test(value) ? value : null;
}
