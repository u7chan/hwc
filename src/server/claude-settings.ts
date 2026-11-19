import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sidecarRoot } from "./chat/claude-sidecar";

// hook を足すイベント。tool の hook は PermissionRequest を承認待ちの合図にし、残りは
// sidecar を消す契機に使う（ADR 0098）。
const HOOK_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;

// 起動のたびに呼ぶ。内容が同じなら書かない。
export async function ensureClaudeSettings(stateRoot: string): Promise<string> {
  const path = join(stateRoot, "claude", "settings.json");
  const content = claudeSettingsJson({
    runtime: process.execPath,
    script: join(import.meta.dir, "claude-hook.ts"),
    root: sidecarRoot(stateRoot),
  });
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing !== content) {
    await mkdir(join(stateRoot, "claude"), { recursive: true, mode: 0o700 });
    await writeFile(path, content);
  }
  return path;
}

export function claudeSettingsJson(props: {
  runtime: string;
  script: string;
  root: string;
}): string {
  // hook のコマンドはシェルが解釈する。パスに空白や記号があっても 1 語になるよう引用する。
  const command = [props.runtime, props.script, props.root].map(shellQuote).join(" ");
  const entry = [{ hooks: [{ type: "command", command, timeout: 5 }] }];
  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, entry]));
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
