import { Hono } from "hono";

const app = new Hono().get("/api/health", (c) => c.json({ ok: true, service: "hwc" }));

export type AppType = typeof app;
export default app;
