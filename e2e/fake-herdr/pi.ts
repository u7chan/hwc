import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ATTACHED_FILES_OPEN } from "../../src/shared/attachments";
import { type CodexFixture, writeCodexThread } from "../fixtures/scenario";
import type { FakeContext } from "./context";
import type { SetAgentStatus } from "./workspaces";

// 会話を残さない（または履歴を置き換える）コマンドは、user メッセージとして追記しない。
const COMMAND_TEXT = /^\/(?:new|compact|hwc-rewind)(?: |$)/;

export function createPi(ctx: FakeContext, setAgentStatus: SetAgentStatus) {
  const { root, pendingPiSessions, findPane, later } = ctx;
  let sendCount = 0;
  let compactionCount = 0;
  let abortCount = 0;

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

  // BFF の編集契約を模す。対象メッセージの親へ戻したことにし、marker を追記する。
  // 実 mypi と同じく、後から送る本文はこの marker の子になる。
  const appendRewindMarker = async (
    paneId: string,
    targetId: string,
    requestId: string,
  ): Promise<void> => {
    const session = findPane(paneId)?.agent_session ?? null;
    const path = session?.agent === "pi" && session.kind === "path" ? session.value : null;
    if (path === null) return;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return;
    }
    let parentId: string | null = null;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown; parentId?: unknown };
        if (entry.id !== targetId) continue;
        parentId = typeof entry.parentId === "string" ? entry.parentId : null;
        break;
      } catch {
        // 壊れた行は無視する。
      }
    }
    const marker = {
      type: "custom",
      id: `rewind-${requestId}`,
      parentId,
      timestamp: new Date().toISOString(),
      customType: "hwc-rewind",
      data: { v: 1, requestId, targetId, leafId: parentId },
    };
    await appendFile(path, `${JSON.stringify(marker)}\n`);
  };

  // 送った本文を架空セッションの user メッセージとして追記する。E2E で確定後の送信カードを
  // 確かめられるようにするためで、対象は agent_session を持つペインの通常本文だけ。
  const appendUserEntry = async (paneId: string, text: string): Promise<void> => {
    if (text.trim() === "") return;
    const session = findPane(paneId)?.agent_session ?? null;
    // 添付を持つペインの Enter は常に本文の送信になる。添付付きの `/compact` も
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

  // pi 拡張がセッションの隣に書く live の段階（docs/adr/pi-integration.md）。実物はターン中に上書きし続けるが、
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

  // mypi の ask_user を模す。pending を置いて blocked にし、answer が現れたら
  // pending / answer を消して working → idle に戻す（docs/adr/pi-integration.md）。
  const askEpochs = new Map<string, number>();

  const askSessionPath = (paneId: string): string | null => {
    const session = findPane(paneId)?.agent_session ?? null;
    return session?.agent === "pi" && session.kind === "path" && session.value
      ? session.value
      : null;
  };

  const cancelAsk = async (paneId: string): Promise<void> => {
    const session = askSessionPath(paneId);
    askEpochs.delete(paneId);
    if (session === null) return;
    await rm(`${session}.ask.json`, { force: true }).catch(() => {});
    await rm(`${session}.ask.answer.json`, { force: true }).catch(() => {});
  };

  // 回答後のセッションに ask_user の tool call/result を残す。BFF が Q&A を会話へ
  // 合成する経路を E2E で確かめるためで、実 mypi の tool result と同じ形にする。
  const appendAskExchange = async (
    sessionPath: string,
    toolCallId: string,
    askId: string,
    question: string,
    options: string[] | null,
    recommended: string | null,
    answer: string,
    kind: "option" | "text",
  ): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(sessionPath, "utf8");
    } catch {
      return;
    }
    let parentId: string | null = null;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown };
        if (typeof entry.id === "string") parentId = entry.id;
      } catch {
        // 壊れた行は無視する。
      }
    }
    if (parentId === null) return;
    const assistantId = `e2e-ask-a-${toolCallId}`;
    const assistant = {
      type: "message",
      id: assistantId,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "ask_user",
            arguments: { question, options, recommended },
          },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    };
    const result = {
      type: "message",
      id: `e2e-ask-r-${toolCallId}`,
      parentId: assistantId,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "ask_user",
        content: [{ type: "text", text: `ユーザーの回答: ${answer}` }],
        details: { status: "answered", askId, winner: "file", kind },
        isError: false,
        timestamp: Date.now(),
      },
    };
    await appendFile(sessionPath, `${JSON.stringify(assistant)}\n${JSON.stringify(result)}\n`);
  };

  const startAsk = async (paneId: string, options: string[] | null): Promise<void> => {
    const session = askSessionPath(paneId);
    if (session === null) return;
    // 前のターンの activity タイマーが、質問待ちの状態を idle に戻さないようにする。
    activityEpochs.set(paneId, (activityEpochs.get(paneId) ?? 0) + 1);
    await clearPiActivity(paneId);
    const pendingPath = `${session}.ask.json`;
    const answerPath = `${session}.ask.answer.json`;
    const id = crypto.randomUUID();
    const toolCallId = `call_ask_${id}`;
    const question = "E2E: この変更をどう進めますか？\n選択肢か自由入力で答えてください。";
    const recommended = options === null ? null : (options[0] ?? null);
    const epoch = (askEpochs.get(paneId) ?? 0) + 1;
    askEpochs.set(paneId, epoch);
    await rm(answerPath, { force: true }).catch(() => {});
    await writeFile(
      pendingPath,
      `${JSON.stringify({
        v: 1,
        id,
        question,
        options,
        recommended,
        freeText: true,
      })}\n`,
      { mode: 0o600 },
    );
    setAgentStatus(paneId, "blocked");

    const poll = async () => {
      if (askEpochs.get(paneId) !== epoch || findPane(paneId) === null) return;
      let raw: string;
      try {
        raw = await readFile(answerPath, "utf8");
      } catch {
        later(poll, 300);
        return;
      }
      let answered = false;
      let answerText: string | null = null;
      let answerKind: "option" | "text" = "option";
      try {
        const value = JSON.parse(raw) as {
          v?: unknown;
          id?: unknown;
          answer?: { kind?: unknown; label?: unknown; text?: unknown };
        };
        if (value.v === 1 && value.id === id) {
          const answer = value.answer;
          if (answer?.kind === "text" && typeof answer.text === "string") {
            answerText = answer.text;
            answerKind = "text";
          } else if (answer?.kind === "option" && typeof answer.label === "string") {
            answerText = answer.label;
          }
          answered = answerText !== null;
        }
      } catch {
        // 壊れた回答は読まなかったことにする。実 mypi も無視する。
      }
      if (!answered) {
        later(poll, 300);
        return;
      }
      // カードが「送信済み」になるのを見せるため、pending を少し残してから消す。
      askEpochs.delete(paneId);
      later(async () => {
        if (findPane(paneId) === null || answerText === null) return;
        await appendAskExchange(
          session,
          toolCallId,
          id,
          question,
          options,
          recommended,
          answerText,
          answerKind,
        );
        await rm(pendingPath, { force: true }).catch(() => {});
        await rm(answerPath, { force: true }).catch(() => {});
        setAgentStatus(paneId, "working");
        later(async () => {
          if (findPane(paneId)?.agent_status === "working") setAgentStatus(paneId, "idle");
        }, 1_200);
      }, 3_000);
    };
    later(poll, 300);
  };

  // 応答を止めると、実 pi は本文の無い assistant をセッションへ追記して葉にする。hwc は
  // それを描画しないので、止めた直後は送った発言が末尾に見える（docs/adr/pi-integration.md）。
  const appendAbort = async (paneId: string): Promise<void> => {
    const target = findPane(paneId);
    const session = target?.agent_session ?? null;
    const path = session?.agent === "pi" && session.kind === "path" ? session.value : null;
    if (path === null || target?.agent_status !== "working") return;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return;
    }
    let parentId: string | null = null;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown };
        if (typeof entry.id === "string") parentId = entry.id;
      } catch {
        // 壊れた行は無視する。
      }
    }
    if (parentId === null) return;
    abortCount += 1;
    const entry = {
      type: "message",
      id: `e2e-abort-${abortCount}`,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        timestamp: Date.now(),
      },
    };
    await appendFile(path, `${JSON.stringify(entry)}\n`);
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
    appendRewindMarker,
    appendUserEntry,
    appendAbort,
    startAsk,
    cancelAsk,
    piActivityPath,
    clearPiActivity,
    writePiActivity,
    startPiActivity,
    appendCompaction,
  };
}

export type Pi = ReturnType<typeof createPi>;
