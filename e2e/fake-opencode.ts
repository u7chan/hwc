import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STARTUP_MODELS } from "./fixtures/scenario";

export async function startFakeOpencode(root: string) {
  const password = "e2e-only";
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const sessions = new Map<string, { id: string; model: unknown; location: unknown }>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.headers.get("authorization") !== authorization)
        return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === "/api/model") {
        return Response.json({
          data: STARTUP_MODELS.map(({ provider, id }) => ({
            id,
            providerID: provider,
            enabled: true,
            limit: { context: 200_000 },
          })),
        });
      }
      if (path === "/api/session" && request.method === "POST") {
        const body = (await request.json()) as { model: unknown; location: unknown };
        const id = `ses_e2e_${sessions.size + 1}`;
        const session = { id, model: body.model, location: body.location };
        sessions.set(id, session);
        return Response.json({ data: session });
      }
      const id = path.split("/")[3] ?? "";
      const session = sessions.get(id);
      if (session) return Response.json({ data: path.endsWith("/context") ? [] : session });
      return new Response(null, { status: 404 });
    },
  });
  await mkdir(join(root, "opencode"), { recursive: true });
  await writeFile(
    join(root, "opencode", "service.json"),
    JSON.stringify({ url: server.url.href, password }),
  );
  return { close: () => server.stop(true) };
}
