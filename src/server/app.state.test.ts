import { expect, test } from "bun:test";
import type { AppState } from "./herdr/state";
import {
  state,
  createFakeStore,
  createTestApp,
  waitFor,
  createSseReader,
} from "./app.test-helpers";

test("GET /api/health returns ok", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "hwc", revision: "dev" });
});

test("GET /api/health reports the revision it was built from", async () => {
  const { app } = createTestApp({ revision: "abc1234" });
  const response = await app.request("/api/health");

  expect(await response.json()).toEqual({ ok: true, service: "hwc", revision: "abc1234" });
});

test("GET /api/state returns the current state and the clock it was sent with", async () => {
  const { app } = createTestApp();
  const before = Date.now();
  const response = await app.request("/api/state");
  const after = Date.now();

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.state).toEqual(state);
  // 状態はキャッシュされても、時刻は送信時に決まる。
  expect(body.now).toBeGreaterThanOrEqual(before);
  expect(body.now).toBeLessThanOrEqual(after);
});

test("GET /api/state loads the state when the store is still empty", async () => {
  const { app } = createTestApp({ state: null });
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect((await response.json()).state).toEqual(state);
});

test("GET /api/state returns 502 when Herdr cannot be read", async () => {
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("socket closed"),
  });
  const response = await app.request("/api/state");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("GET /api/events streams the current state first, then every update", async () => {
  const store = createFakeStore(state);
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  // 送信時刻は要求を受けた時点で決まる。要求の前に測る。
  const before = Date.now();
  const response = await app.request("/api/events", { signal: controller.signal });

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  const first = await events.nextMessage();
  const after = Date.now();
  expect(first.state).toEqual(state);
  // 状態が動かない間も時刻が進むよう、now は送信時刻になる。
  expect(first.now).toBeGreaterThanOrEqual(before);
  expect(first.now).toBeLessThanOrEqual(after);

  const next: AppState = { ...state, focusedPaneId: null };
  store.push(next, true);
  expect(await events.next()).toEqual(next);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events stays open and sends the state once Herdr becomes readable", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.nextEvent()).toEqual({ event: "unavailable", data: "" });

  store.push(state, true);
  expect(await events.next()).toEqual(state);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events uses an update that arrived first instead of reporting unavailability", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  store.fireOnSubscribe(state);
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.nextEvent()).toMatchObject({ event: null });

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events flushes an update that arrives while the initial state is being sent", async () => {
  const store = createFakeStore(state);
  const next: AppState = { ...state, focusedPaneId: "w1:p9" };
  store.fireOnSubscribe(next);
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.next()).toEqual(state);
  expect(await events.next()).toEqual(next);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events keeps the stream alive with a heartbeat comment", async () => {
  const store = createFakeStore(state);
  const { app } = createTestApp({
    store,
    sseHeartbeatMs: 10,
  });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const deadline = Date.now() + 2_000;
  while (!received.includes(": ping") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }

  await reader.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);

  // 状態は先に届き、その後にコメント行が続く。
  expect(received).toContain(JSON.stringify(state));
  expect(received).toContain(": ping");
  // event: を付けると client の onmessage ではなく専用の listener に飛ぶ。付けてはいけない。
  expect(received).not.toContain("event: ping");
});

test("GET /api/events unsubscribes when the client is gone before the initial state is sent", async () => {
  const store = createFakeStore(state);
  const { app } = createTestApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");

  await response.body.cancel();
  controller.abort();

  await waitFor(() => store.listenerCount() === 0);
});
