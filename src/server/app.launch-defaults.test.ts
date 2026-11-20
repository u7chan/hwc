import { expect, test } from "bun:test";
import type { LaunchDefault } from "../shared/launch-defaults";
import { createTestApp } from "./app.test-helpers";
import { createLaunchDefaultsStore } from "./launch-defaults";

const sonnet: LaunchDefault = { model: { provider: "claude", id: "sonnet" }, effort: "high" };

function createFakeDefaults(fail: () => boolean = () => false) {
  return createLaunchDefaultsStore({
    read: () => null,
    write: () => {
      if (fail()) throw new Error("disk full");
    },
  });
}

function putJson(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("GET /api/launch-defaults returns the saved defaults without caching", async () => {
  const launchDefaults = createFakeDefaults();
  launchDefaults.set("claude", sonnet);
  const { app } = createTestApp({ launchDefaults });

  const response = await app.request("/api/launch-defaults");

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ defaults: { claude: sonnet } });
});

test("GET /api/launch-defaults is empty before anything is saved", async () => {
  const { app } = createTestApp({ launchDefaults: createFakeDefaults() });
  expect(await (await app.request("/api/launch-defaults")).json()).toEqual({ defaults: {} });
});

test("PUT /api/launch-defaults saves one agent and returns the whole snapshot", async () => {
  const launchDefaults = createFakeDefaults();
  launchDefaults.set("claude", sonnet);
  const { app } = createTestApp({ launchDefaults });
  const beam = { model: { provider: "example", id: "@demo/beam-small" }, effort: null };

  const response = await app.request("/api/launch-defaults", putJson({ agent: "pi", value: beam }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ defaults: { claude: sonnet, pi: beam } });
  expect(launchDefaults.get()).toEqual({ claude: sonnet, pi: beam });
});

test("PUT /api/launch-defaults with null clears the agent's default", async () => {
  const launchDefaults = createFakeDefaults();
  launchDefaults.set("claude", sonnet);
  const { app } = createTestApp({ launchDefaults });

  const response = await app.request(
    "/api/launch-defaults",
    putJson({ agent: "claude", value: null }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ defaults: {} });
  expect(launchDefaults.get()).toEqual({});
});

test.each([
  { agent: "shell", value: sonnet },
  { agent: "claude" },
  { agent: "claude", value: { model: { provider: "claude", id: "--help" }, effort: null } },
  { agent: "claude", value: { model: { provider: "claude", id: "sonnet" }, effort: "" } },
  { agent: "claude", value: { model: { provider: "claude", id: "sonnet" } } },
  null,
])("PUT /api/launch-defaults refuses %j and keeps the saved defaults", async (body) => {
  const launchDefaults = createFakeDefaults();
  launchDefaults.set("claude", sonnet);
  const { app } = createTestApp({ launchDefaults });

  const response = await app.request("/api/launch-defaults", putJson(body));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
  expect(launchDefaults.get()).toEqual({ claude: sonnet });
});

test("PUT /api/launch-defaults reports a failed write and keeps the saved defaults", async () => {
  let fail = false;
  const launchDefaults = createFakeDefaults(() => fail);
  launchDefaults.set("claude", sonnet);
  fail = true;
  const { app } = createTestApp({ launchDefaults });

  const response = await app.request(
    "/api/launch-defaults",
    putJson({ agent: "claude", value: null }),
  );

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "settings_unavailable" });
  expect(launchDefaults.get()).toEqual({ claude: sonnet });
});

test("PUT /api/launch-defaults requires a JSON body", async () => {
  const { app } = createTestApp({ launchDefaults: createFakeDefaults() });
  const response = await app.request("/api/launch-defaults", {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ agent: "claude", value: sonnet }),
  });
  expect(response.status).toBe(415);
});
