import { createInterface } from "node:readline";
import { DEFAULT_PI_EFFORT, DEFAULT_PI_MODEL, STARTUP_MODELS } from "./fixtures/scenario";

const args = process.argv.slice(2);
if (args.join(" ") === "--offline --list-models") {
  console.log("provider  model  context  max-out  thinking  images");
  for (const model of STARTUP_MODELS)
    console.log(
      `${model.provider}  ${model.id}  200K  32K  ${model.efforts.pi.length ? "yes" : "no"}  yes`,
    );
  process.exit(0);
}
if (args.slice(0, 4).join(" ") !== "--offline --mode rpc --no-session") process.exit(2);
const requested = args[4] === "--model" ? args[5] : undefined;
const selected =
  requested === undefined
    ? undefined
    : STARTUP_MODELS.find((item) => `${item.provider}/${item.id}` === requested);
if (requested !== undefined && selected === undefined) process.exit(2);
const model = selected ?? DEFAULT_PI_MODEL;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { type: string };
  let data: unknown;
  switch (message.type) {
    case "get_available_models":
      data = {
        models: [
          { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
          ...STARTUP_MODELS.map(({ provider, id }) => ({ provider, id, contextWindow: 200_000 })),
        ],
      };
      break;
    case "get_state":
      data = {
        model: { provider: model.provider, id: model.id, reasoning: model.efforts.pi.length > 0 },
        // モデル未指定の起動では、実際の起動と同じ既定の effort を返す。
        ...(selected === undefined ? { thinkingLevel: DEFAULT_PI_EFFORT } : {}),
      };
      break;
    case "get_available_thinking_levels":
      data = { levels: model.efforts.pi.length ? model.efforts.pi : ["off"] };
      break;
    default:
      process.exit(2);
  }
  console.log(JSON.stringify({ type: "response", command: message.type, success: true, data }));
}
