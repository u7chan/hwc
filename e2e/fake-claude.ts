import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.join(" ") === "--version") {
  console.log("2.1.328 (Claude Code)");
  process.exit(0);
}
if (!args.includes("--print") || !args.includes("--input-format")) process.exit(2);

const models = [
  ["default", "claude-opus-5-5", "Default (recommended)"],
  ["fable", "claude-fable-5-2", "Fable 5.2"],
  ["opus", "claude-opus-5-5", "Opus 5.5"],
  ["sonnet", "claude-sonnet-5-5", "Sonnet 5.5"],
  ["haiku", "claude-haiku-5-5", "Haiku 5.5"],
].map(([value, resolvedModel, displayName]) => ({ value, resolvedModel, displayName }));

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as {
    type?: string;
    request_id?: string;
    request?: { subtype?: string };
  };
  if (message.type !== "control_request" || message.request?.subtype !== "list_models") {
    process.exit(2);
  }
  console.log(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { models },
      },
    }),
  );
  break;
}
