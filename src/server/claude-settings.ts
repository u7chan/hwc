import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sidecarRoot } from "./chat/claude-sidecar";
import { claudeLiveRoot } from "./chat/claude-live";

// hook を足すイベント。tool の hook は PermissionRequest を承認待ちの合図にし、残りは
// sidecar を消す契機に使う（ADR 0112）。
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
// pluginDir はこのリポに同梱する mod。無ければ Claude は hook だけで起動する。
export type ClaudeLaunch = { settings: string; pluginDir: string | null };

export async function ensureClaudeSettings(stateRoot: string): Promise<ClaudeLaunch> {
  const path = join(stateRoot, "claude", "settings.json");
  const live = claudeLiveRoot(stateRoot);
  const content = claudeSettingsJson({
    runtime: process.execPath,
    script: join(import.meta.dir, "claude-hook.ts"),
    root: sidecarRoot(stateRoot),
    live,
  });
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing !== content) {
    await mkdir(join(stateRoot, "claude"), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
  // mod は親ディレクトリを作らない。起動前に空の置き場を用意する。作れなくても、
  // 速度と使用量が出ないだけで hook は使えるようにする。
  await mkdir(live, { recursive: true, mode: 0o700 }).catch(() => {});
  // writeFile の mode は作るときだけ効く。既に別のモードで作られたファイルは、内容が同じで
  // 書き直さなくても、sidecar と同じ 0600 に直す。
  await chmod(path, 0o600);
  return { settings: path, pluginDir: await bundledModDir() };
}

async function bundledModDir(): Promise<string | null> {
  const dir = join(import.meta.dir, "../../claude-mod");
  const info = await stat(dir).catch(() => null);
  return info?.isDirectory() === true ? dir : null;
}

export function claudeSettingsJson(props: {
  runtime: string;
  script: string;
  root: string;
  live: string;
}): string {
  // hook のコマンドはシェルが解釈する。パスに空白や記号があっても 1 語になるよう引用する。
  const command = [props.runtime, props.script, props.root].map(shellQuote).join(" ");
  const entry = [{ hooks: [{ type: "command", command, timeout: 5 }] }];
  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, entry]));
  return `${JSON.stringify({ hooks, env: { HWC_CLAUDE_LIVE_DIR: props.live } }, null, 2)}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
