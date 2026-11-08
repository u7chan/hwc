import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatClient } from "./server/chat/pi";
import { createOpencodeChatClient } from "./server/chat/opencode";
import { createCodexChatClient } from "./server/chat/codex";
import { createPaneClient } from "./server/herdr/panes";
import { createWorktreeClient } from "./server/herdr/worktrees";
import { createBranchReader, createGitClient } from "./server/git";
import { createStateStore } from "./server/herdr/state";
import { loadSnapshot, startStateSync } from "./server/herdr/sync";
import { createApp } from "./server/app";
import { createAgentModelsClient } from "./server/agent-models";
import { createPullRequestReader } from "./server/pull-request";
import index from "../index.html";

const git = createGitClient();
const store = createStateStore({
  load: () => loadSnapshot(),
  branch: createBranchReader(),
  git,
});

startStateSync({
  store,
  onError: (error) => console.error(`herdr sync: ${error.message}`),
});

// 開発中はどの版かを画面で確かめられるように、起動時のコミットを出す。
const revision = readRevision();

const app = createApp({
  store,
  panes: createPaneClient(),
  worktrees: createWorktreeClient(),
  chat: createChatClient(),
  opencode: createOpencodeChatClient({ servicePath: process.env.HWC_OPENCODE_SERVICE }),
  codex: createCodexChatClient(),
  models: createAgentModelsClient({ servicePath: process.env.HWC_OPENCODE_SERVICE }),
  pullRequests: createPullRequestReader(),
  git,
  revision,
});

// Herdr の応答を待つルート（ワークツリー作成・削除・モデル指定の作成）は数十秒返さない。
// Bun の既定の idleTimeout（10 秒）で接続を切らないよう、ソケット側の待ち（60 秒）と
// エージェント起動（30 秒）を 1 リクエストで行うワークツリー作成のクライアント期限
// （180 秒）を覆う値を置く。
const IDLE_TIMEOUT_SECONDS = 200;

const server = Bun.serve({
  port: Number(process.env.PORT ?? 30000),
  hostname: process.env.HOST ?? "0.0.0.0",
  development: true,
  idleTimeout: IDLE_TIMEOUT_SECONDS,
  routes: {
    "/": index,
    "/api/*": app.fetch,
  },
});

const port = server.port ?? Number(process.env.PORT ?? 30000);
const localHost =
  server.hostname === "0.0.0.0" || server.hostname === "::" ? "localhost" : server.hostname;
const localUrl = `http://${localHost}:${port}`;
console.log(`hwc ready: ${localUrl} (${revision})`);
if (server.hostname === "0.0.0.0" || server.hostname === "::") {
  console.log(`LAN bind: ${server.hostname}:${port}`);
}
openBrowserOnce(localUrl, port);

function openBrowserOnce(url: string, port: number): void {
  if (process.env.HWC_NO_OPEN === "1" || process.env.CI || !process.stdout.isTTY) return;
  // watch の再起動で開き直さないよう、起動元プロセス単位で一度だけにする。
  const marker = join(tmpdir(), `hwc-open-${port}-${process.ppid}`);
  if (existsSync(marker)) return;
  writeFileSync(marker, "");
  openBrowser(url);
}

function openBrowser(url: string): void {
  const wsl =
    process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : wsl
          ? ["cmd.exe", "/c", "start", "", url]
          : ["xdg-open", url];
  try {
    Bun.spawn(command, {
      cwd: wsl ? "/mnt/c/Windows" : undefined,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // 起動ログの URL を手で開けるので、自動オープンの失敗は致命にしない。
  }
}

function readRevision(): string {
  if (process.env.HWC_REVISION) return process.env.HWC_REVISION;
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  const hash = result.success ? result.stdout.toString().trim() : "";
  return hash === "" ? "dev" : hash;
}
