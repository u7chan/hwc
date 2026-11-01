import { createStateStore } from "./server/herdr/state";
import { loadSnapshot, startStateSync } from "./server/herdr/sync";
import { createApp } from "./server/app";
import index from "../index.html";

const store = createStateStore({ load: () => loadSnapshot() });

startStateSync({
  store,
  onError: (error) => console.error(`herdr sync: ${error.message}`),
});

const app = createApp({ store });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 30000),
  hostname: process.env.HOST ?? "0.0.0.0",
  development: true,
  routes: {
    "/": index,
    "/api/*": app.fetch,
  },
});

console.log(`hwc ready: http://${server.hostname}:${server.port}`);
