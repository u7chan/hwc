import index from "../index.html";
import app from "./server/app";

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
