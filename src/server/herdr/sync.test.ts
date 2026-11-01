import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type SubscriptionSpec } from "./socket";
import { createStateStore, type HerdrSnapshot } from "./state";
import { loadSnapshot, startStateSync } from "./sync";

type FakeHerdr = {
  path: string;
  methods: () => string[];
  subscriptions: () => Array<{ subscriptions: SubscriptionSpec[] }>;
  snapshotRequests: () => number;
  setPaneIds: (ids: string[]) => void;
  setRejectedPaneIds: (ids: string[]) => void;
  setAutoRelease: (enabled: boolean) => void;
  setMalformedSnapshot: (enabled: boolean) => void;
  rejectedSubscriptions: () => number;
  dropStatusConnections: () => void;
  releaseSnapshots: () => void;
  pushEvent: (name: string, data?: unknown) => void;
  close: () => Promise<void>;
};

const running: Array<{ close: () => Promise<void> }> = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(running.splice(0).map((herdr) => herdr.close()));
});

async function startFakeHerdr(): Promise<FakeHerdr> {
  const directory = await mkdtemp(join(tmpdir(), "hwc-sync-"));
  const path = join(directory, "herdr.sock");
  const sockets = new Set<net.Socket>();
  const eventSockets = new Set<net.Socket>();
  const subscriptionSockets = new Map<net.Socket, SubscriptionSpec[]>();
  const methods: string[] = [];
  const subscriptions: Array<{ subscriptions: SubscriptionSpec[] }> = [];
  let snapshots = 0;
  let paneIds = ["w1:p1"];
  let rejectedPaneIds: string[] = [];
  let autoRelease = false;
  let malformed = false;
  let rejections = 0;
  let replies: Array<() => void> = [];

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      eventSockets.delete(socket);
      subscriptionSockets.delete(socket);
    });

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: string; method?: string; params?: unknown };
        methods.push(message.method ?? "");

        if (message.method === "session.snapshot") {
          const workspaceId = malformed ? "" : `w${++snapshots}`;
          const panes = paneIds.map((paneId) => ({
            pane_id: paneId,
            workspace_id: workspaceId,
            tab_id: `${workspaceId}:t1`,
          }));
          const reply = () =>
            socket.write(
              `${JSON.stringify({
                id: message.id,
                result: {
                  type: "session_snapshot",
                  snapshot: {
                    focused_workspace_id: workspaceId,
                    workspaces: [{ workspace_id: workspaceId }],
                    tabs: [{ tab_id: `${workspaceId}:t1`, workspace_id: workspaceId }],
                    panes,
                  },
                },
              })}\n`,
            );
          if (autoRelease) reply();
          else replies.push(reply);
          continue;
        }

        if (message.method === "events.subscribe") {
          const params = message.params as { subscriptions: SubscriptionSpec[] };
          if (params.subscriptions.some((item) => rejectedPaneIds.includes(item.pane_id ?? ""))) {
            rejections += 1;
            socket.write(
              `${JSON.stringify({
                id: message.id,
                error: { code: "invalid_params", message: "pane not found" },
              })}\n`,
            );
            socket.destroy();
            continue;
          }
          eventSockets.add(socket);
          subscriptionSockets.set(socket, params.subscriptions);
          subscriptions.push(params);
          socket.write(
            `${JSON.stringify({ id: message.id, result: { type: "subscription_started" } })}\n`,
          );
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });

  const herdr: FakeHerdr = {
    path,
    methods: () => [...methods],
    subscriptions: () => [...subscriptions],
    snapshotRequests: () => snapshots,
    setPaneIds: (ids) => {
      paneIds = ids;
    },
    setRejectedPaneIds: (ids) => {
      rejectedPaneIds = ids;
    },
    setAutoRelease: (enabled) => {
      autoRelease = enabled;
    },
    setMalformedSnapshot: (enabled) => {
      malformed = enabled;
    },
    rejectedSubscriptions: () => rejections,
    dropStatusConnections: () => {
      for (const [socket, specs] of subscriptionSockets) {
        if (specs.some((item) => item.pane_id)) socket.destroy();
      }
    },
    releaseSnapshots: () => {
      const releasing = replies;
      replies = [];
      for (const reply of releasing) reply();
    },
    pushEvent: (name, data = {}) => {
      for (const socket of eventSockets) socket.write(`${JSON.stringify({ event: name, data })}\n`);
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
  running.push(herdr);
  return herdr;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met in time");
}

function start(herdr: FakeHerdr) {
  const store = createStateStore({
    load: async () =>
      (await request<{ snapshot: HerdrSnapshot }>("session.snapshot", {}, { path: herdr.path }))
        .snapshot,
  });
  const stop = startStateSync({ store, path: herdr.path, reconnectDelayMs: 10 });
  stops.push(stop);
  return { store, stop };
}

test("startStateSync subscribes to state events and loads a snapshot when the subscription starts", async () => {
  const herdr = await startFakeHerdr();
  const { store } = start(herdr);

  await waitFor(() => herdr.snapshotRequests() === 1);
  herdr.releaseSnapshots();
  await waitFor(() => store.get() !== null);

  expect(store.get()?.focusedWorkspaceId).toBe("w1");
  const types = herdr.subscriptions()[0]?.subscriptions.map((item) => item.type) ?? [];
  expect(types).toContain("workspace.created");
  expect(types).toContain("tab.renamed");
  expect(types).not.toContain("pane.output_matched");
  expect(types).not.toContain("layout.updated");
});

test("startStateSync subscribes to agent status changes of the panes it knows", async () => {
  const herdr = await startFakeHerdr();
  const { store } = start(herdr);

  await waitFor(() => herdr.snapshotRequests() === 1);
  herdr.releaseSnapshots();
  await waitFor(() => store.get() !== null);

  await waitFor(() => herdr.subscriptions().length === 2);
  const statusSubscriptions = (herdr.subscriptions()[1]?.subscriptions ?? []).filter(
    (item) => item.type === "pane.agent_status_changed",
  );
  expect(statusSubscriptions).toEqual([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]);
});

test("startStateSync resubscribes when the pane set changes", async () => {
  const herdr = await startFakeHerdr();
  herdr.setAutoRelease(true);
  const { store } = start(herdr);

  await waitFor(() => store.get() !== null);
  await waitFor(() => herdr.subscriptions().length === 2);

  herdr.setPaneIds(["w1:p1", "w1:p2"]);
  herdr.pushEvent("pane.created");
  await waitFor(() => herdr.subscriptions().length === 3);
  const statusSubscriptions = (herdr.subscriptions()[2]?.subscriptions ?? []).filter(
    (item) => item.type === "pane.agent_status_changed",
  );
  expect(statusSubscriptions).toEqual([
    { type: "pane.agent_status_changed", pane_id: "w1:p1" },
    { type: "pane.agent_status_changed", pane_id: "w1:p2" },
  ]);
});

test("an event after the subscription starts reloads the snapshot", async () => {
  const herdr = await startFakeHerdr();
  const { store } = start(herdr);

  await waitFor(() => herdr.snapshotRequests() === 1);
  herdr.releaseSnapshots();
  await waitFor(() => store.get()?.focusedWorkspaceId === "w1");

  herdr.pushEvent("pane.agent_status_changed", { pane_id: "w1:p1" });
  await waitFor(() => herdr.snapshotRequests() === 2);
  herdr.releaseSnapshots();

  await waitFor(() => store.get()?.focusedWorkspaceId === "w2");
});

test("consecutive events coalesce into a single extra reload", async () => {
  const herdr = await startFakeHerdr();
  const { store } = start(herdr);

  await waitFor(() => herdr.snapshotRequests() === 1);
  herdr.releaseSnapshots();
  await waitFor(() => store.get()?.focusedWorkspaceId === "w1");

  herdr.pushEvent("workspace.renamed");
  await waitFor(() => herdr.snapshotRequests() === 2);
  herdr.pushEvent("tab.renamed");
  herdr.pushEvent("pane.closed");
  expect(herdr.snapshotRequests()).toBe(2);

  herdr.releaseSnapshots();
  await waitFor(() => herdr.snapshotRequests() === 3);
  herdr.releaseSnapshots();

  await waitFor(() => store.get()?.focusedWorkspaceId === "w3");
  expect(herdr.snapshotRequests()).toBe(3);
});

test("a rejected agent status subscription does not stop lifecycle events", async () => {
  const herdr = await startFakeHerdr();
  herdr.setAutoRelease(true);
  herdr.setPaneIds(["w1:p1", "w1:p9"]);
  herdr.setRejectedPaneIds(["w1:p9"]);
  const { store } = start(herdr);

  await waitFor(() => store.get() !== null);
  await waitFor(() => herdr.rejectedSubscriptions() === 1);

  // 拒否された時点で状態を取り直す（イベントを待たない）。
  await waitFor(() => herdr.snapshotRequests() === 2);

  const before = herdr.snapshotRequests();
  herdr.pushEvent("tab.renamed");
  await waitFor(() => herdr.snapshotRequests() > before);

  // 拒否 → 取得 → 同じペイン集合で再試行、を往復し続けない。
  expect(herdr.snapshotRequests()).toBeLessThan(6);
});

test("after a rejected pane disappears the status subscription is re-established", async () => {
  const herdr = await startFakeHerdr();
  herdr.setAutoRelease(true);
  herdr.setPaneIds(["w1:p1", "w1:p9"]);
  herdr.setRejectedPaneIds(["w1:p9"]);
  const { store } = start(herdr);

  await waitFor(() => herdr.rejectedSubscriptions() === 1);
  herdr.setPaneIds(["w1:p1"]);
  herdr.pushEvent("pane.closed");

  await waitFor(() =>
    herdr
      .subscriptions()
      .some(
        (item) =>
          item.subscriptions.length === 1 &&
          item.subscriptions[0]?.type === "pane.agent_status_changed",
      ),
  );
  const statusSubscriptions = herdr
    .subscriptions()
    .flatMap((item) => item.subscriptions)
    .filter((item) => item.type === "pane.agent_status_changed");
  expect(statusSubscriptions.at(-1)).toEqual({
    type: "pane.agent_status_changed",
    pane_id: "w1:p1",
  });
  expect(store.get()).not.toBeNull();
});

test("stop ends both subscriptions", async () => {
  const herdr = await startFakeHerdr();
  herdr.setAutoRelease(true);
  const { store, stop } = start(herdr);

  await waitFor(() => store.get() !== null);
  await waitFor(() => herdr.subscriptions().length === 2);

  stop();
  const before = herdr.snapshotRequests();
  herdr.pushEvent("tab.renamed");
  await Bun.sleep(50);

  expect(herdr.snapshotRequests()).toBe(before);
});

test("a dropped agent status connection reloads the state", async () => {
  const herdr = await startFakeHerdr();
  herdr.setAutoRelease(true);
  const { store } = start(herdr);

  await waitFor(() => store.get() !== null);
  await waitFor(() => herdr.subscriptions().length === 2);

  const before = herdr.snapshotRequests();
  herdr.dropStatusConnections();

  // 切断中の状態変化はイベントで届かないので、再接続時に取り直す。
  await waitFor(() => herdr.snapshotRequests() > before);
  expect(store.get()).not.toBeNull();
  await waitFor(() => herdr.subscriptions().length >= 3);
});

test("loadSnapshot requests session.snapshot and parses the payload", async () => {
  const herdr = await startFakeHerdr();
  herdr.setAutoRelease(true);

  const snapshot = await loadSnapshot({ path: herdr.path });

  expect(herdr.methods()).toEqual(["session.snapshot"]);
  expect(snapshot.focused_workspace_id).toBe("w1");
  expect(snapshot.panes?.[0]?.pane_id).toBe("w1:p1");
});

test("loadSnapshot rejects a snapshot that does not match the contract", async () => {
  const herdr = await startFakeHerdr();
  herdr.setAutoRelease(true);
  herdr.setMalformedSnapshot(true);

  await expect(loadSnapshot({ path: herdr.path })).rejects.toThrow("workspace_id");
});
