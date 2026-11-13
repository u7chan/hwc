import { createHash } from "node:crypto";
import { stripAttachedFiles } from "../../shared/attachments";
import { asRecord, type CodexReader, nextCursor, withCodex } from "../codex";
import {
  type ChatMessage,
  type ChatSnapshot,
  type SessionChatClient,
  chatAttachments,
} from "./contract";
import { ChatUnavailableError } from "./errors";
import { limitMessages, MAX_CHAT_MESSAGES } from "./limit";

const TURNS_PER_PAGE = 20;
const MAX_TURN_PAGES = 25;

export function createCodexChatClient(options: { read?: CodexReader } = {}): SessionChatClient {
  const read = options.read ?? withCodex;
  const running = new Map<string, Promise<ChatSnapshot>>();

  const snapshot = (sessionId: string) =>
    read(undefined, async (request): Promise<ChatSnapshot> => {
      const raw = await request("thread/read", { threadId: sessionId });
      const thread = asRecord(asRecord(raw)?.thread);
      if (thread?.id !== sessionId) throw new ChatUnavailableError("codex thread is missing");

      let messages: ChatMessage[] = [];
      let cursor: string | null = null;
      let truncated = false;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_TURN_PAGES; page += 1) {
        // summary は assistant 本文を省く。full は legacy / paginated の両方で読め、
        // スレッドの resume や既読更新をせずに会話を取得できる。
        const raw = await request("thread/turns/list", {
          threadId: sessionId,
          limit: TURNS_PER_PAGE,
          sortDirection: "desc",
          itemsView: "full",
          ...(cursor === null ? {} : { cursor }),
        });
        const result = asRecord(raw);
        if (!Array.isArray(result?.data)) {
          throw new ChatUnavailableError("codex turns are missing");
        }
        const older = result.data.toReversed().flatMap(projectTurn);
        const limited = limitMessages([...older, ...messages]);
        messages = limited.messages;
        cursor = nextCursor(result);
        truncated = limited.truncated || cursor !== null;
        if (limited.truncated || messages.length >= MAX_CHAT_MESSAGES || cursor === null) break;
        if (seen.has(cursor)) throw new ChatUnavailableError("codex cursor did not advance");
        seen.add(cursor);
      }

      const body: Omit<ChatSnapshot, "etag"> = {
        messages,
        model: nonEmptyText(thread.model),
        effort: nonEmptyText(thread.reasoningEffort),
        truncated,
        // 読み取り API は usage と圧縮要約を返さない。現在の文脈量や要約は推測しない。
        context: null,
        compaction: null,
      };
      const etag = createHash("sha256")
        .update(sessionId)
        .update(JSON.stringify(body))
        .digest("hex");
      return { ...body, etag };
    });

  return {
    snapshot(sessionId) {
      const pending = running.get(sessionId);
      if (pending) return pending;
      const settled = snapshot(sessionId).finally(() => running.delete(sessionId));
      running.set(sessionId, settled);
      return settled;
    },
  };
}

function projectTurn(raw: unknown): ChatMessage[] {
  const turn = asRecord(raw);
  if (typeof turn?.id !== "string" || !Array.isArray(turn.items)) {
    throw new ChatUnavailableError("codex turn is invalid");
  }
  const messages: ChatMessage[] = [];
  for (const value of turn.items) {
    const item = asRecord(value);
    if (!item || typeof item.id !== "string") continue;
    const id = `${turn.id}/${item.id}`;
    const at =
      finiteNumber(item.startedAtMs) ??
      finiteNumber(item.completedAtMs) ??
      (finiteNumber(turn.startedAt) ?? 0) * 1000;
    if (item.type === "agentMessage" && typeof item.text === "string" && item.text !== "") {
      messages.push({ id, role: "agent", text: item.text, at });
    } else if (item.type === "userMessage") {
      const { text, attachments } = stripAttachedFiles(userText(item.content));
      if (text === "" && attachments.length === 0) continue;
      messages.push({
        id,
        role: "user",
        text,
        at,
        ...(attachments.length === 0 ? {} : { attachments: chatAttachments(attachments) }),
      });
    }
  }
  return messages;
}

function userText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let image = false;
  for (const value of content) {
    const part = asRecord(value);
    if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
    if (part?.type === "image" || part?.type === "localImage") image = true;
  }
  return parts.join("\n\n") || (image ? "[画像]" : "");
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
