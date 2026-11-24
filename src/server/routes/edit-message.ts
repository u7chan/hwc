import { stat } from "node:fs/promises";
import { exceedsTextLimit } from "../herdr/panes";
import { findPane } from "../herdr/state";
import { supportsFolderTrust } from "../../shared/agents";
import { isRewindId, type EditMessageBody, type RewindMarker } from "../../shared/rewind";
import { readRewindMarker } from "../chat/pi-rewind";
import type { AppContext, IdContext } from "./context";

const TAIL_SNIFF_BYTES = 256 * 1024;
const MARKER_POLL_MS = 100;

type Known = { path: string; marker: RewindMarker; sentText: string | null };

type Parsed = { ok: true; value: EditMessageBody } | { ok: false };

function parseBody(body: unknown): Parsed {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false };
  const record = body as Record<string, unknown>;
  if (!isRewindId(record.messageId) || !isRewindId(record.requestId)) return { ok: false };
  if (typeof record.text !== "string" || record.text.trim() === "") return { ok: false };
  return {
    ok: true,
    value: { messageId: record.messageId, requestId: record.requestId, text: record.text },
  };
}

export function createEditMessageHandlers(ctx: AppContext) {
  const {
    store,
    panes,
    chat,
    current,
    freshPane,
    folderTrust,
    resolvePane,
    paneFailure,
    editMarkerTimeoutMs,
  } = ctx;
  const inFlight = new Set<string>();
  // ペインごとの requestId。同じ再送で marker を二度探さず、本文送信済みも判定する。
  const known = new Map<string, Map<string, Known>>();

  const knownFor = (paneId: string, requestId: string, path: string): Known | undefined => {
    const found = known.get(paneId)?.get(requestId);
    return found?.path === path ? found : undefined;
  };

  const remember = (
    paneId: string,
    requestId: string,
    path: string,
    marker: RewindMarker,
    sentText: string | null,
  ) => {
    const byRequest = known.get(paneId) ?? new Map<string, Known>();
    byRequest.set(requestId, { path, marker, sentText });
    // ペインを長く使っても Map が増え続けないように、古い要求から落とす。
    while (byRequest.size > 64) {
      const oldest = byRequest.keys().next().value;
      if (oldest === undefined) break;
      byRequest.delete(oldest);
    }
    known.set(paneId, byRequest);
  };

  const sendText = async (paneId: string, text: string, path: string): Promise<boolean> => {
    // marker を待つ間に /new などでセッションが変わっていたら、別の会話へ送らない。
    const source = store.chatSource(paneId);
    if (source === null || source.agent !== "pi" || source.path !== path) return false;
    const state = await current();
    const pane = state === null ? null : findPane(state, paneId);
    if (pane === null || pane.agent !== "pi" || !pane.chat) return false;
    // 質問の待ちの間に送ると、TUI のダイアログが入力を受け取る。
    if (pane.agentStatus === "working" || pane.agentStatus === "blocked") return false;
    // キャッシュが idle のままでも、Herdr が既に blocked なら送らない。working は巻き戻しの
    // 途中で立つことがあるため、ここでは blocked だけを見る。
    let fresh;
    try {
      fresh = await freshPane(paneId);
    } catch {
      return false;
    }
    if (fresh === null || fresh.agent !== "pi" || !fresh.chat) return false;
    if (fresh.agentStatus === "blocked") return false;
    // 再取得でセッションが変わっていたら、前の会話の本文を新しい会話へ送らない。
    const latest = store.chatSource(paneId);
    if (latest === null || latest.agent !== "pi" || latest.path !== path) return false;
    try {
      await panes.send({ paneId, text, submit: true });
      return true;
    } catch {
      return false;
    }
  };

  return {
    edit: async (c: IdContext) => {
      const body = await c.req.json().catch(() => null);
      const parsed = parseBody(body);
      if (!parsed.ok) return c.json({ error: "invalid_request" }, 400);
      const { messageId, requestId, text } = parsed.value;

      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId, pane } = resolved;
      if (pane.agent !== "pi" || !pane.chat) return c.json({ error: "no_chat" }, 404);
      // blocked の pi は質問の待ち。TUI のダイアログへ本文を流さない。
      if (pane.agentStatus === "working" || pane.agentStatus === "blocked") {
        return c.json({ error: "not_editable" }, 409);
      }
      if (inFlight.has(paneId)) return c.json({ error: "edit_in_flight" }, 409);

      const source = store.chatSource(paneId);
      if (source === null || source.agent !== "pi") return c.json({ error: "no_chat" }, 404);
      // 初回だけでなく、marker 既知の再送でも通常入力と同じ上限を守る。
      if (exceedsTextLimit(text)) return c.json({ error: "text_too_long" }, 413);

      inFlight.add(paneId);
      try {
        if (supportsFolderTrust(pane.agent)) {
          try {
            if (await folderTrust.inspect(pane)) {
              return c.json({ error: "confirmation_pending" }, 409);
            }
          } catch (error) {
            return paneFailure(c, error);
          }
        }

        let snapshot;
        try {
          snapshot = await chat.snapshot(source.path);
        } catch {
          return c.json({ error: "chat_unavailable" }, 502);
        }
        if (snapshot.canRewind !== true) return c.json({ error: "not_editable" }, 409);

        const path = source.path;
        const beforeFile = await stat(path).catch(() => null);
        let inode = beforeFile?.ino ?? null;
        const size = beforeFile?.size ?? 0;

        // 同じ requestId の再送。BFF の Map を先に引き、無ければセッション末尾を見る。
        let existing = knownFor(paneId, requestId, source.path);
        if (existing === undefined) {
          try {
            const scanned = await readRewindMarker(
              path,
              Math.max(0, size - TAIL_SNIFF_BYTES),
              requestId,
              inode,
            );
            if (scanned.marker !== null) {
              remember(paneId, requestId, source.path, scanned.marker, scanned.sentText);
              existing = knownFor(paneId, requestId, source.path);
            }
          } catch {
            // reader の失敗は、これから送るコマンドの待ちで改めて見る。
          }
        }

        if (existing !== undefined) {
          if (existing.marker.targetId !== messageId) return c.json({ error: "edit_failed" }, 502);
          if (existing.sentText?.trim() === text.trim()) return c.json({ ok: true });
          if (!(await sendText(paneId, text, source.path))) {
            return c.json({ error: "send_failed", rewound: true }, 502);
          }
          existing.sentText = text;
          return c.json({ ok: true });
        }

        const message = snapshot.messages.find((item) => item.id === messageId);
        if (
          message === undefined ||
          message.role !== "user" ||
          message.text.trim() === "" ||
          (message.attachments?.length ?? 0) > 0 ||
          snapshot.leafId === messageId
        ) {
          return c.json({ error: "not_editable" }, 409);
        }
        try {
          // 状態の照合は送信の直前に行う。folderTrust の確認中に blocked へ変わる競合や、
          // 状態のキャッシュが古いままの送信を防ぐ。
          const fresh = await freshPane(paneId);
          if (fresh === null) return c.json({ error: "pane_not_found" }, 404);
          if (fresh.agent !== "pi" || !fresh.chat) {
            return c.json({ error: "no_chat" }, 404);
          }
          if (fresh.agentStatus === "working" || fresh.agentStatus === "blocked") {
            return c.json({ error: "not_editable" }, 409);
          }
          const latest = store.chatSource(paneId);
          if (latest === null || latest.agent !== "pi" || latest.path !== source.path) {
            return c.json({ error: "edit_failed" }, 502);
          }
        } catch (error) {
          return paneFailure(c, error);
        }
        try {
          await panes.send({
            paneId,
            text: `/hwc-rewind ${messageId} ${requestId}`,
            submit: true,
          });
        } catch {
          return c.json({ error: "edit_failed" }, 502);
        }

        // コマンド送信後に追記された範囲だけを読む。chat reader とは別のハンドル。
        let offset = size;
        let marker: RewindMarker | null = null;
        const deadline = Date.now() + editMarkerTimeoutMs;
        while (marker === null && Date.now() < deadline) {
          try {
            const read = await readRewindMarker(path, offset, requestId, inode);
            offset = read.offset;
            inode = read.inode;
            marker = read.marker;
            if (marker !== null) remember(paneId, requestId, source.path, marker, read.sentText);
          } catch {
            // 読み取りの一時失敗は期限まで再試行する。
          }
          if (marker === null) await Bun.sleep(MARKER_POLL_MS);
        }
        if (marker === null) return c.json({ error: "edit_failed" }, 502);
        if (marker.targetId !== messageId) return c.json({ error: "edit_failed" }, 502);

        const currentKnown = knownFor(paneId, requestId, source.path);
        if (currentKnown?.sentText?.trim() === text.trim()) return c.json({ ok: true });
        if (!(await sendText(paneId, text, source.path))) {
          return c.json({ error: "send_failed", rewound: true }, 502);
        }
        if (currentKnown !== undefined) currentKnown.sentText = text;
        return c.json({ ok: true });
      } finally {
        inFlight.delete(paneId);
      }
    },
  };
}
