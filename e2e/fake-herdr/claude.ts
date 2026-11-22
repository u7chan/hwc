import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_VERSION, claudeTranscriptPath } from "../fixtures/scenario";
import type { FakeContext } from "./context";
import type { SetAgentStatus } from "./workspaces";

// E2E 用の架空のターン。実物と同じく、prompt・要求・応答・ツール・結果は別々の行として
// 時間差で追記する（docs/adr/claude-integration.md）。最初の 2 秒は新しい prompt がまだ無いので、帯は空の枠の
// ままになる。ツールの結果は 20 秒後に書くので、そのあとは取得が null になる。
const PROMPT_DELAY_MS = 2_000;
// 要求中（API の応答待ち）に、mod が書くのと同じ形の速度を置く（docs/adr/claude-integration.md）。
// prompt の直後に置き、assistant が書かれるまで残す。1 秒間隔の取得でも確実に見える幅にする。
const RATE_DELAY_MS = PROMPT_DELAY_MS + 6_000;
const TOOL_DELAY_MS = 16_000;
const RESULT_DELAY_MS = 20_000;

// 架空の Claude Code。実機（2.1.328 / 2.1.330）で確かめた、質問とモデルの切り替えまわりの
// transcript と hook の動きだけを再現する（docs/adr/claude-integration.md）。
//   - Esc でダイアログを閉じると、assistant の tool_use と、is_error の tool_result と、
//     「[Request interrupted by user for tool use]」の user を一度に書く。hook は呼ばれない。
//   - 次の発言（UserPromptSubmit）で、hook が応答待ちの sidecar を消す。
//   - `/model <alias>` は、hwc が許可の印を置いていれば、確認ダイアログを開かずに切り替え、
//     PostModelSwitch の hook と同じ完了の記録を書く。`/effort <level>` は結果を transcript へ書く。
//     印が無い `/model` は何もしない（実機では確認ダイアログが開く。E2E は成功の経路だけを再現する）。
export function createClaude(ctx: FakeContext, setAgentStatus: SetAgentStatus) {
  const { root, findPane, later } = ctx;
  let count = 0;
  let sequence = 0;

  const sessionOf = (paneId: string): string | null => {
    const session = findPane(paneId)?.agent_session ?? null;
    return session?.agent === "claude" && session.kind === "id" && session.value
      ? session.value
      : null;
  };

  const sidecarPath = (sessionId: string) => join(root, "claude", "pending", `${sessionId}.json`);
  const switchPath = (sessionId: string, kind: "allow" | "done") =>
    join(root, "claude", "model-switch", `${sessionId}.${kind}.json`);
  const livePath = (sessionId: string) => join(root, "claude", "live", `${sessionId}.json`);

  // mod の代わりに速度を書く。null は「計測していない」で、ファイルは残る。
  const publishRate = async (sessionId: string, tokPerSecond: number | null): Promise<void> => {
    await mkdir(join(root, "claude", "live"), { recursive: true }).catch(() => {});
    const body = JSON.stringify({ v: 1, sessionId, at: Date.now(), tokPerSecond });
    await writeFile(livePath(sessionId), body).catch(() => {});
  };

  // 追記する entry の親にする uuid。末尾が uuid を持たない行（api-request）でも、その前の
  // entry から枝を伸ばす。
  const tailUuid = async (path: string): Promise<string | null> => {
    const raw = await readFile(path, "utf8").catch(() => "");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const uuid = (JSON.parse(lines[index]!) as { uuid?: unknown }).uuid;
        if (typeof uuid === "string" && uuid !== "") return uuid;
      } catch {
        // 書きかけの行は読み飛ばす。
      }
    }
    return null;
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
        version: CLAUDE_VERSION,
        isSidechain: false,
      };
      parentUuid = entry.uuid;
      return entry;
    };
    const entries = build(next);
    await appendFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  };

  // uuid を持たない行（api-request など）は、枝を切らないよう単独で追記する。
  const appendEntry = async (sessionId: string, entry: object) => {
    const path = claudeTranscriptPath(root, sessionId);
    await appendFile(path, `${JSON.stringify(entry)}\n`);
  };

  // フィクスチャ専用の入力 `/activity` のターンを始める。prompt が書かれるまでの 2 秒間は、
  // クライアントが前のターンとの比較で待つ（docs/adr/claude-integration.md）。
  const start = async (paneId: string): Promise<void> => {
    const sessionId = sessionOf(paneId);
    if (sessionId === null) return;
    sequence += 1;
    const run = sequence;
    const working = () => sequence === run && findPane(paneId)?.agent_status === "working";

    // ターンは始まったが、prompt はまだ書かれていない。
    setAgentStatus(paneId, "working");

    later(async () => {
      if (!working()) return;
      await append(sessionId, (next) => [
        {
          ...next(),
          type: "user",
          message: { role: "user", content: "追加の依頼を確認してください。" },
        },
      ]);
      await appendEntry(sessionId, {
        type: "api-request",
        id: `api-e2e-${run}`,
        querySource: "repl_main_thread",
        timestamp: new Date().toISOString(),
        version: CLAUDE_VERSION,
      });
    }, PROMPT_DELAY_MS);

    // mod と同じく 500ms ごとに上書きする。1 回だけ書くと、BFF の鮮度（2.5 秒）で消える。
    let publishing = true;
    later(async () => {
      while (publishing && working()) {
        await publishRate(sessionId, 68.4);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }, RATE_DELAY_MS);

    later(async () => {
      if (!working()) return;
      publishing = false;
      await publishRate(sessionId, null);
      await append(sessionId, (next) => [
        {
          ...next(),
          type: "assistant",
          requestRef: `api-e2e-${run}`,
          message: {
            id: `msg-e2e-${run}`,
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [{ type: "text", text: "手順を確認しています。" }],
          },
          perTurnEffort: "xhigh",
        },
        {
          ...next(),
          type: "assistant",
          requestRef: `api-e2e-${run}`,
          message: {
            id: `msg-e2e-${run}`,
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [
              {
                type: "tool_use",
                id: `tool-e2e-${run}`,
                name: "Read",
                input: { file_path: "docs/quickstart.md" },
              },
            ],
          },
          perTurnEffort: "xhigh",
        },
      ]);
    }, TOOL_DELAY_MS);

    later(async () => {
      if (!working()) return;
      await append(sessionId, (next) => [
        {
          ...next(),
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: `tool-e2e-${run}`, content: "ok" }],
          },
        },
      ]);
    }, RESULT_DELAY_MS);
  };

  return {
    start,

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

    // `/model` と `/effort`。ローカルコマンドなので、会話の発言にはせず、結果だけを transcript の
    // user 行（<local-command-stdout>）に書く。扱ったら true。
    async runLocalCommand(paneId: string, text: string): Promise<boolean> {
      const sessionId = sessionOf(paneId);
      const command = /^\/(model|effort) ([a-z]+)$/.exec(text.trim());
      if (sessionId === null || command === null) return false;
      const [, name, argument] = command as unknown as [string, "model" | "effort", string];

      let output: string;
      if (name === "model") {
        let allowed = false;
        try {
          const allow = JSON.parse(await readFile(switchPath(sessionId, "allow"), "utf8")) as {
            model?: unknown;
            until?: unknown;
          };
          allowed =
            allow.model === argument &&
            typeof allow.until === "number" &&
            allow.until >= Date.now();
        } catch {
          // 印が無い。
        }
        if (!allowed) return true;
        const resolved = argument === "fable" ? "claude-fable-5-2" : `claude-${argument}-5-5`;
        await mkdir(join(root, "claude", "model-switch"), { recursive: true });
        await writeFile(
          switchPath(sessionId, "done"),
          JSON.stringify({
            v: 1,
            sessionId,
            at: Date.now(),
            model: resolved,
            requested: argument,
          }),
        );
        await rm(switchPath(sessionId, "allow"), { force: true });
        output = `Set model to \`${argument}\` and saved as your default for new sessions`;
      } else {
        output = `Set effort level to ${argument} (saved as your default for new sessions)`;
      }

      await append(sessionId, (next) => [
        {
          ...next(),
          type: "user",
          message: {
            role: "user",
            content: `<command-name>/${name}</command-name>\n<command-args>${argument}</command-args>`,
          },
        },
        {
          ...next(),
          type: "user",
          message: {
            role: "user",
            content: `<local-command-stdout>${output}</local-command-stdout>`,
          },
        },
      ]);
      return true;
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
