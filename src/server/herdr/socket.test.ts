import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, request, socketPath, subscribe } from "./socket";

type WireRequest = { id?: string; method?: string; params?: unknown };

type FakeHerdr = {
  path: string;
  sent: WireRequest[][];
  connectionCount: () => number;
  close: () => Promise<void>;
};

const running: FakeHerdr[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((herdr) => herdr.close()));
});

async function startFakeHerdr(
  onRequest: (message: WireRequest, socket: net.Socket, connection: number) => void,
): Promise<FakeHerdr> {
  const directory = await mkdtemp(join(tmpdir(), "hwc-socket-"));
  const path = join(directory, "herdr.sock");
  const sockets = new Set<net.Socket>();
  const sent: WireRequest[][] = [];
  let connections = 0;

  const server = net.createServer((socket) => {
    const index = connections++;
    sent.push([]);
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line) as WireRequest;
        sent[index].push(message);
        onRequest(message, socket, index);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });

  const herdr: FakeHerdr = {
    path,
    sent,
    connectionCount: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
  running.push(herdr);
  return herdr;
}

function reply(socket: net.Socket, message: unknown) {
  socket.write(`${JSON.stringify(message)}\n`);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met in time");
}

test("request resolves with the result of a single request", async () => {
  const herdr = await startFakeHerdr((message, socket) => {
    reply(socket, { id: message.id, result: { type: "pong", version: "0.9.5", protocol: 22 } });
  });

  const result = await request<{ type: string; version: string; protocol: number }>(
    "ping",
    {},
    { path: herdr.path },
  );

  expect(result).toEqual({ type: "pong", version: "0.9.5", protocol: 22 });
  expect(herdr.sent[0]).toHaveLength(1);
  expect(herdr.sent[0][0]).toEqual({ id: expect.any(String), method: "ping", params: {} });
});

test("request parses a response that is split across chunks", async () => {
  const herdr = await startFakeHerdr((message, socket) => {
    const line = `${JSON.stringify({ id: message.id, result: { type: "pong" } })}\n`;
    socket.write(line.slice(0, 10));
    setTimeout(() => socket.write(line.slice(10)), 10);
  });

  expect(await request("ping", {}, { path: herdr.path })).toEqual({ type: "pong" });
});

test("request rejects with HerdrError when Herdr returns an error response", async () => {
  const herdr = await startFakeHerdr((message, socket) => {
    reply(socket, {
      id: message.id,
      error: { code: "invalid_params", message: "pane_id is required" },
    });
  });

  const error = await request("pane.read", { pane_id: "" }, { path: herdr.path }).catch(
    (reason: unknown) => reason,
  );

  if (!(error instanceof HerdrError)) throw new Error(`unexpected rejection: ${String(error)}`);
  expect(error.code).toBe("invalid_params");
  expect(error.message).toBe("invalid_params: pane_id is required");
});

test("request rejects when the response is not JSON", async () => {
  const herdr = await startFakeHerdr((_message, socket) => {
    socket.write("not json\n");
  });

  await expect(request("ping", {}, { path: herdr.path })).rejects.toThrow("invalid JSON");
});

test("request rejects when no response arrives in time", async () => {
  const herdr = await startFakeHerdr(() => {});

  await expect(request("ping", {}, { path: herdr.path, timeoutMs: 50 })).rejects.toThrow(
    "timed out after 50ms",
  );
});

test("request rejects when the connection closes before a response", async () => {
  const herdr = await startFakeHerdr((_message, socket) => socket.end());

  await expect(request("ping", {}, { path: herdr.path })).rejects.toThrow("connection closed");
});

test("subscribe keeps the connection event-only and forwards pushed events", async () => {
  const herdr = await startFakeHerdr((message, socket) => {
    if (message.method !== "events.subscribe") return;
    reply(socket, { id: message.id, result: { type: "subscription_started" } });
    reply(socket, { event: "pane.updated", data: { pane_id: "w1:p1" } });
  });

  const events: Array<[string, unknown]> = [];
  let started = 0;
  const stop = subscribe({
    events: [{ type: "pane.updated" }],
    path: herdr.path,
    reconnectDelayMs: 10,
    onStarted: () => {
      started += 1;
    },
    onEvent: (event, data) => events.push([event, data]),
    onLost: () => {},
  });

  await waitFor(() => events.length === 1);
  stop();

  expect(started).toBe(1);
  expect(events[0]).toEqual(["pane.updated", { pane_id: "w1:p1" }]);
  expect(herdr.sent[0]).toEqual([
    {
      id: expect.any(String),
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.updated" }] },
    },
  ]);
});

test("subscribe reports every lost subscription and resubscribes", async () => {
  const herdr = await startFakeHerdr((message, socket, connection) => {
    reply(socket, { id: message.id, result: { type: "subscription_started" } });
    if (connection >= 2) return;
    reply(socket, { id: message.id, error: { code: "events_lost", message: "buffer overflow" } });
    socket.destroy();
  });

  let lost = 0;
  let started = 0;
  const stop = subscribe({
    events: [{ type: "pane.updated" }],
    path: herdr.path,
    reconnectDelayMs: 10,
    onStarted: () => {
      started += 1;
    },
    onEvent: () => {},
    onLost: () => {
      lost += 1;
    },
  });

  await waitFor(() => started === 3);
  stop();

  expect(lost).toBe(2);
});

test("subscribe resubscribes after the connection drops unexpectedly", async () => {
  const herdr = await startFakeHerdr((message, socket, connection) => {
    reply(socket, { id: message.id, result: { type: "subscription_started" } });
    if (connection === 0) setTimeout(() => socket.destroy(), 10);
  });

  let lost = 0;
  let started = 0;
  const stop = subscribe({
    events: [{ type: "pane.updated" }],
    path: herdr.path,
    reconnectDelayMs: 10,
    onStarted: () => {
      started += 1;
    },
    onEvent: () => {},
    onLost: () => {
      lost += 1;
    },
  });

  await waitFor(() => started === 2);
  stop();

  expect(lost).toBeGreaterThanOrEqual(1);
});

test("subscribe stops reconnecting after stop()", async () => {
  const herdr = await startFakeHerdr((message, socket) => {
    reply(socket, { id: message.id, result: { type: "subscription_started" } });
  });

  let started = 0;
  const stop = subscribe({
    events: [{ type: "pane.updated" }],
    path: herdr.path,
    reconnectDelayMs: 10,
    onStarted: () => {
      started += 1;
    },
    onEvent: () => {},
    onLost: () => {},
  });

  await waitFor(() => started === 1);
  stop();
  await Bun.sleep(50);

  expect(herdr.connectionCount()).toBe(1);
});

test("subscribe does not retry a rejected subscription", async () => {
  const herdr = await startFakeHerdr((message, socket) => {
    reply(socket, { id: message.id, error: { code: "invalid_params", message: "unknown event" } });
  });

  const errors: Error[] = [];
  const stop = subscribe({
    events: [{ type: "not.an.event" }],
    path: herdr.path,
    reconnectDelayMs: 10,
    onStarted: () => {},
    onEvent: () => {},
    onLost: () => {},
    onError: (error) => errors.push(error),
  });

  await waitFor(() => errors.length === 1);
  await Bun.sleep(50);
  stop();

  expect(errors[0]).toBeInstanceOf(HerdrError);
  expect(herdr.connectionCount()).toBe(1);
});

test("socketPath resolves the socket in the documented order", () => {
  expect(socketPath({ HERDR_SOCKET_PATH: "/tmp/explicit.sock" })).toBe("/tmp/explicit.sock");
  expect(socketPath({ HERDR_SOCKET_PATH: "/tmp/explicit.sock", HERDR_SESSION: "named" })).toBe(
    "/tmp/explicit.sock",
  );
  expect(socketPath({ HOME: "/home/example", HERDR_SESSION: "named" })).toBe(
    "/home/example/.config/herdr/sessions/named/herdr.sock",
  );
  expect(socketPath({ HOME: "/home/example" })).toBe("/home/example/.config/herdr/herdr.sock");
});
