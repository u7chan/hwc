import { createPaneClient } from "./server/herdr/panes";
import { createStateStore } from "./server/herdr/state";
import { loadSnapshot, startStateSync } from "./server/herdr/sync";
import { createApp } from "./server/app";
import index from "../index.html";

const store = createStateStore({ load: () => loadSnapshot() });

startStateSync({
  store,
  onError: (error) => console.error(`herdr sync: ${error.message}`),
});

// 開発中はどの版かを画面で確かめられるように、起動時のコミットを出す。
const revision = readRevision();

const app = createApp({ store, panes: createPaneClient(), revision });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 30000),
  hostname: process.env.HOST ?? "0.0.0.0",
  development: true,
  routes: {
    "/": index,
    "/api/*": app.fetch,
  },
});

console.log(`hwc ready: http://${server.hostname}:${server.port} (${revision})`);

function readRevision(): string {
  if (process.env.HWC_REVISION) return process.env.HWC_REVISION;
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  const hash = result.success ? result.stdout.toString().trim() : "";
  return hash === "" ? "dev" : hash;
}
