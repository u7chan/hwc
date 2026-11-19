import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { claudeTranscriptPath } from "../fixtures/scenario";
import type { FakeContext } from "./context";

// 架空の Claude Code。実機（2.1.328）で確かめた、質問まわりの transcript と hook の動きだけを
// 再現する（ADR 0098、0099）。
//   - Esc でダイアログを閉じると、assistant の tool_use と、is_error の tool_result と、
//     「[Request interrupted by user for tool use]」の user を一度に書く。hook は呼ばれない。
//   - 次の発言（UserPromptSubmit）で、hook が応答待ちの sidecar を消す。
export function createClaude(ctx: FakeContext) {
  const { root, findPane } = ctx;
  let count = 0;

  const sessionOf = (paneId: string): string | null => {
    const session = findPane(paneId)?.agent_session ?? null;
    return session?.agent === "claude" && session.kind === "id" && session.value
      ? session.value
      : null;
  };

  const sidecarPath = (sessionId: string) => join(root, "claude", "pending", `${sessionId}.json`);

  // 末尾の entry の uuid。追記する entry をその子にして、active branch を伸ばす。
  const tailUuid = async (path: string): Promise<string | null> => {
    const raw = await readFile(path, "utf8").catch(() => "");
    const last = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .at(-1);
    if (last === undefined) return null;
    try {
      const uuid = (JSON.parse(last) as { uuid?: unknown }).uuid;
      return typeof uuid === "string" ? uuid : null;
    } catch {
      return null;
    }
  };

  const append = async (sessionId: string, build: (next: () => object) => object[]) => {
    const path = claudeTranscriptPath(root, sessionId);
    let parentUuid = await tailUuid(path);
    const next = () => {
      count += 1;
      const entry = {
        uuid: `fake-claude-${count}`,
        parentUuid,
        timestamp: new Date().toISOString(),
        isSidechain: false,
      };
      parentUuid = entry.uuid;
      return entry;
    };
    const entries = build(next);
    await appendFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  };

  return {
    // Esc で質問を閉じる。応答待ちが sidecar にあるペインだけ。sidecar は残す（hook が無いので）。
    async dismissQuestion(paneId: string): Promise<void> {
      const sessionId = sessionOf(paneId);
      if (sessionId === null) return;
      let pending: { toolUseId?: unknown; questions?: unknown } | null = null;
      try {
        const sidecar = JSON.parse(await readFile(sidecarPath(sessionId), "utf8")) as {
          pending?: { kind?: unknown; toolUseId?: unknown; questions?: unknown };
        };
        if (sidecar.pending?.kind === "question") pending = sidecar.pending;
      } catch {
        return;
      }
      if (typeof pending?.toolUseId !== "string") return;
      const toolUseId = pending.toolUseId;
      const input = { questions: pending.questions };

      await append(sessionId, (next) => [
        {
          ...next(),
          type: "assistant",
          message: {
            id: `fake-msg-${toolUseId}`,
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input }],
          },
        },
        {
          ...next(),
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: "The user doesn't want to proceed with this tool use.",
                is_error: true,
              },
            ],
          },
        },
        {
          ...next(),
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
          },
        },
      ]);
    },

    // 送った本文を user として追記し、応答待ちの sidecar を消す。Claude のペインだけ。
    async appendUser(paneId: string, text: string): Promise<boolean> {
      const sessionId = sessionOf(paneId);
      if (sessionId === null || text.trim() === "") return false;
      await append(sessionId, (next) => [
        { ...next(), type: "user", message: { role: "user", content: text } },
      ]);
      await rm(sidecarPath(sessionId), { force: true });
      return true;
    },
  };
}

export type Claude = ReturnType<typeof createClaude>;
