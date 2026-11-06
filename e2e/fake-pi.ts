import { createInterface } from "node:readline";
import { STARTUP_MODELS } from "./fixtures/scenario";

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
const model =
  args[4] === "--model"
    ? STARTUP_MODELS.find((item) => `${item.provider}/${item.id}` === args[5])
    : undefined;
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
      if (!model) process.exit(2);
      data = {
        model: { provider: model.provider, id: model.id, reasoning: model.efforts.pi.length > 0 },
      };
      break;
    case "get_available_thinking_levels":
      if (!model) process.exit(2);
      data = { levels: model.efforts.pi.length ? model.efforts.pi : ["off"] };
      break;
    default:
      process.exit(2);
  }
  console.log(JSON.stringify({ type: "response", command: message.type, success: true, data }));
}
