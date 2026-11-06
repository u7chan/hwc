import { createInterface } from "node:readline";
import { join } from "node:path";
import { STARTUP_MODELS, type CodexFixture } from "./fixtures/scenario";

const home = process.env.CODEX_HOME;
if (!home || process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(2);

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: { threadId?: string; cursor?: string; limit?: number };
  };
  if (message.method === "initialized") continue;
  let result: unknown;
  try {
    switch (message.method) {
      case "initialize":
        result = {};
        break;
      case "config/read":
        result = { config: { model_provider: "example" } };
        break;
      case "model/list":
        result = {
          data: STARTUP_MODELS.map(({ id, efforts }) => ({
            id,
            model: id,
            hidden: false,
            supportedReasoningEfforts: efforts.codex.map((reasoningEffort) => ({
              reasoningEffort,
            })),
          })),
          nextCursor: null,
        };
        break;
      case "thread/read":
      case "thread/turns/list": {
        const params = message.params;
        if (!params?.threadId || !/^[a-zA-Z0-9_-]+$/.test(params.threadId)) throw new Error();
        const session = (await Bun.file(
          join(home, "threads", `${params.threadId}.json`),
        ).json()) as CodexFixture;
        if (message.method === "thread/read") {
          result = { thread: { ...session.thread, turns: [] } };
        } else {
          const start = Number(params.cursor ?? 0);
          const end = start + (params.limit ?? 20);
          const turns = session.turns.toReversed();
          result = {
            data: turns.slice(start, end),
            nextCursor: end < turns.length ? String(end) : null,
          };
        }
        break;
      }
      default:
        throw new Error("Only read-only requests are supported");
    }
    process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32600, message: "fixture unavailable" } })}\n`,
    );
  }
}
