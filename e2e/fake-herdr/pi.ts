import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ATTACHED_FILES_OPEN } from "../../src/shared/attachments";
import { type CodexFixture, writeCodexThread } from "../fixtures/scenario";
import type { FakeContext } from "./context";
import type { SetAgentStatus } from "./workspaces";

// 会話を残さない（または履歴を置き換える）コマンドは、user メッセージとして追記しない。
const COMMAND_TEXT = /^\/(?:new|compact)(?: |$)/;

export function createPi(ctx: FakeContext, setAgentStatus: SetAgentStatus) {
  const { root, pendingPiSessions, findPane, later } = ctx;
  let sendCount = 0;
  let compactionCount = 0;

  // 最初の user メッセージでセッションを作る。実 pi と同じく、起動時の model_change と
  // thinking_level_change もこの時点でまとめて書く。
  const writePiSessionHeader = async (paneId: string): Promise<void> => {
    const pending = pendingPiSessions.get(paneId);
    if (pending === undefined) return;
    pendingPiSessions.delete(paneId);
    await mkdir(dirname(pending.path), { recursive: true });
    await writeFile(
      pending.path,
      [
        {
          type: "session",
          version: 3,
          id: crypto.randomUUID(),
          cwd: pending.cwd,
          timestamp: "2026-01-01T09:00:00.000Z",
        },
        {
          type: "model_change",
          id: "m1",
          parentId: null,
          provider: pending.provider,
          modelId: pending.modelId,
        },
        {
          type: "thinking_level_change",
          id: "t1",
          parentId: "m1",
          thinkingLevel: pending.effort,
        },
      ]
        .map((item) => `${JSON.stringify(item)}\n`)
        .join(""),
    );
  };

  // 送った本文を架空セッションの user メッセージとして追記する。E2E で確定後の送信カードを
  // 確かめられるようにするためで、対象は agent_session を持つペインの通常本文だけ。
  const appendUserEntry = async (paneId: string, text: string): Promise<void> => {
    if (text.trim() === "") return;
    const session = findPane(paneId)?.agent_session ?? null;
    // 添付を持つペインの Enter は常に本文の送信になる（ADR 0018）。添付付きの `/compact` も
    // 本文として送られるので、コマンド扱いは注記が無いときだけ。
    const command = !text.includes(ATTACHED_FILES_OPEN) && COMMAND_TEXT.test(text.trim());
    if (command) return;
    if (session?.agent === "codex" && session.kind === "id" && session.value) {
      const path = join(root, "codex", "threads", `${session.value}.json`);
      const fixture = (await Bun.file(path).json()) as CodexFixture;
      sendCount += 1;
      fixture.turns.push({
        id: `turn_send_${sendCount}`,
        startedAt: Date.now() / 1000,
        items: [
          { type: "userMessage", id: `u${sendCount}`, content: [{ type: "text", text }] },
          { type: "agentMessage", id: `a${sendCount}`, text: "E2E: Codex の返答です。" },
        ],
      });
      await writeCodexThread(root, session.value, fixture.thread.model, fixture.turns);
      return;
    }
    const path = session?.kind === "path" ? session.value : null;
    if (path === null) return;
    await writePiSessionHeader(paneId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return;
    }
    // 現在の葉を親にする。fixture の最後のエントリ（t1）から伸ばす。
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const last = lines.at(-1);
    let parentId: string | null = null;
    if (last !== undefined) {
      try {
        const entry = JSON.parse(last) as { id?: unknown };
        parentId = typeof entry.id === "string" ? entry.id : null;
      } catch {
        parentId = null;
      }
    }
    sendCount += 1;
    const entry = {
      type: "message",
      id: `e2e-send-${sendCount}`,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: text, timestamp: Date.now() },
    };
    await appendFile(path, `${JSON.stringify(entry)}\n`);
  };

  // pi 拡張がセッションの隣に書く live の段階（ADR 0035）。実物はターン中に上書きし続けるが、
  // E2E では phase の切り替わりと末尾の描画だけを確かめるため、2 回書いて短時間で消す。
  const piActivityPath = (paneId: string): string | null => {
    const session = findPane(paneId)?.agent_session ?? null;
    return session?.agent === "pi" && session.kind === "path" && session.value
      ? `${session.value}.thinking.json`
      : null;
  };

  // 送信のたびに増やす。古いタイマーが新しいターンの状態を上書きしないようにする。
  const activityEpochs = new Map<string, number>();

  const clearPiActivity = async (paneId: string): Promise<void> => {
    const path = piActivityPath(paneId);
    if (path !== null) await rm(path, { force: true }).catch(() => {});
  };

  const writePiActivity = async (paneId: string, body: Record<string, unknown>) => {
    const path = piActivityPath(paneId);
    if (path === null) return;
    await writeFile(path, `${JSON.stringify(body)}\n`).catch(() => {});
  };

  const startPiActivity = async (paneId: string): Promise<void> => {
    const session = findPane(paneId)?.agent_session ?? null;
    if (session?.agent !== "pi") {
      // pi 以外は sidecar を持たない。working の間だけ行が出る（live 領域は増えない）ことを
      // E2E で確かめられるように、同じ長さだけ working にする。
      const epoch = (activityEpochs.get(paneId) ?? 0) + 1;
      activityEpochs.set(paneId, epoch);
      setAgentStatus(paneId, "working");
      later(async () => {
        if (activityEpochs.get(paneId) !== epoch) return;
        setAgentStatus(paneId, "idle");
      }, 6_000);
      return;
    }
    const epoch = (activityEpochs.get(paneId) ?? 0) + 1;
    activityEpochs.set(paneId, epoch);
    const current = () => activityEpochs.get(paneId) === epoch;
    await writePiActivity(paneId, { v: 1, at: Date.now(), phase: "waiting" });
    setAgentStatus(paneId, "working");
    // 折り返しであふれる長さにして、2 行分の確保と上側の切り取りを E2E で見る。
    later(async () => {
      if (!current() || findPane(paneId)?.agent_status !== "working") return;
      await writePiActivity(paneId, {
        v: 1,
        at: Date.now(),
        phase: "thinking",
        text: "E2E: 依頼の手順を組み立てています。長い行は折り返して 2 行に収まり、あふれた上側は切り取られます。\n次に bash で確認します。",
        tokPerSecond: 42.3,
      });
    }, 1_200);
    later(async () => {
      if (!current()) return;
      await clearPiActivity(paneId);
      setAgentStatus(paneId, "idle");
    }, 6_000);
  };

  // /compact の完了を架空セッションに追記する。最後の user メッセージを kept の先頭にし、
  // 圧縮の区切りが会話の時系列に置かれることを E2E で確かめられるようにする。
  const appendCompaction = async (paneId: string): Promise<boolean> => {
    const session = findPane(paneId)?.agent_session ?? null;
    const path = session?.kind === "path" ? session.value : null;
    if (path === null) return false;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return false;
    }
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    let parentId: string | null = null;
    let keptId: string | null = null;
    for (const line of lines) {
      let entry: { id?: unknown; type?: unknown; message?: { role?: unknown } };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (typeof entry.id !== "string") continue;
      parentId = entry.id;
      if (entry.type === "message" && entry.message?.role === "user") keptId = entry.id;
    }
    if (parentId === null || keptId === null) return false;
    compactionCount += 1;
    const entry = {
      type: "compaction",
      id: `e2e-compaction-${compactionCount}`,
      parentId,
      timestamp: new Date().toISOString(),
      summary: "E2E: 直前までの会話を圧縮しました。",
      firstKeptEntryId: keptId,
      tokensBefore: 48_000,
    };
    await appendFile(path, `${JSON.stringify(entry)}\n`);
    return true;
  };

  return {
    activityEpochs,
    writePiSessionHeader,
    appendUserEntry,
    piActivityPath,
    clearPiActivity,
    writePiActivity,
    startPiActivity,
    appendCompaction,
  };
}

export type Pi = ReturnType<typeof createPi>;
