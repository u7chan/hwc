import { expect, test } from "bun:test";
import { createTestApp, createFakeRestart, waitFor } from "./app.test-helpers";
import { createRestartSettingsStore, type RestartSettingsFile } from "./restart";

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function putJson(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("GET /api/restart returns the saved command and toggle", async () => {
  const { restartSettings } = createFakeRestart({ command: "/opt/hwc/restart", afterPull: true });
  const { app } = createTestApp({ restartSettings });

  const response = await app.request("/api/restart");

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ command: "/opt/hwc/restart", afterPull: true });
});

test("PUT /api/restart saves an absolute path and the pull toggle", async () => {
  const { restartSettings } = createFakeRestart();
  const { app } = createTestApp({ restartSettings });

  const response = await app.request(
    "/api/restart",
    putJson({ command: "/opt/hwc/restart", afterPull: true }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ command: "/opt/hwc/restart", afterPull: true });
  expect(restartSettings.get()).toEqual({ command: "/opt/hwc/restart", afterPull: true });

  // 空に戻すと未設定に戻る。トグルは残す。
  const cleared = await app.request("/api/restart", putJson({ command: "  ", afterPull: true }));
  expect(await cleared.json()).toEqual({ command: null, afterPull: true });
});

test("PUT /api/restart refuses a command that is not an absolute path", async () => {
  const { restartSettings } = createFakeRestart({ command: "/opt/hwc/restart" });
  const { app } = createTestApp({ restartSettings });

  const response = await app.request(
    "/api/restart",
    putJson({ command: "restart-hwc", afterPull: false }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
  expect(restartSettings.get()).toEqual({ command: "/opt/hwc/restart", afterPull: false });
});

test("PUT /api/restart keeps the previous settings when the write fails", async () => {
  const file: RestartSettingsFile = {
    read: () => null,
    write: () => {
      throw new Error("disk full");
    },
  };
  const { app } = createTestApp({ restartSettings: createRestartSettingsStore(file) });

  const response = await app.request(
    "/api/restart",
    putJson({ command: "/opt/hwc/restart", afterPull: false }),
  );

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "settings_unavailable" });
});

test("POST /api/restart refuses a server without a command", async () => {
  const { restartSettings, runs } = createFakeRestart();
  const { app } = createTestApp({ restartSettings });

  const response = await app.request("/api/restart", postJson({}));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "command_not_configured" });
  expect(runs).toEqual([]);
});

test("POST /api/restart refuses a command that cannot be executed", async () => {
  const { restartSettings, restart, runs } = createFakeRestart({
    command: "/opt/hwc/restart",
    executable: false,
  });
  const { app } = createTestApp({ restartSettings, restart });

  const response = await app.request("/api/restart", postJson({}));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "command_not_executable" });
  expect(runs).toEqual([]);
});

test("POST /api/restart answers before starting the command", async () => {
  const { restartSettings, restart, runs } = createFakeRestart({ command: "/opt/hwc/restart" });
  const { app } = createTestApp({ restartSettings, restart, restartDelayMs: 0 });

  const response = await app.request("/api/restart", postJson({}));

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true });
  // コマンドが HWC を止める場合でも、応答を書き終えてから起動する。
  expect(runs).toEqual([]);
  await waitFor(() => runs.length === 1);
  // 手元からの再起動は BFF のチェックアウトで動く。
  expect(runs).toEqual([{ command: "/opt/hwc/restart", cwd: process.cwd() }]);
});
