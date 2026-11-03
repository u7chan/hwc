import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScenario } from "./fixtures/scenario";

type WireRequest = { id?: string; method?: string; params?: unknown };

export type FakeHerdr = {
  socketPath: string;
  root: string;
  close: () => Promise<void>;
};

const MAX_MESSAGE_CHARS = 1024 * 1024;

// 実 Herdr のソケットに触れず、E2E で使う架空の状態だけを返す。プロトコルは BFF が
// 実際に使う範囲に絞り、本番コードのソケット経路をそのまま通す。
export async function startFakeHerdr(): Promise<FakeHerdr> {
  const root = await mkdtemp(join(tmpdir(), "hwc-e2e-"));
  const socketPath = join(root, "herdr.sock");
  const scenario = await createScenario(root);
  const snapshot = structuredClone(scenario.snapshot);
  const outputs = new Map(Object.entries(scenario.outputs));
  const revisions = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  const subscribers = new Set<net.Socket>();

  const send = (socket: net.Socket, message: unknown) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  };

  const broadcast = (event: string, data: unknown = {}) => {
    for (const socket of subscribers) send(socket, { event, data });
  };

  const findPane = (paneId: string) =>
    snapshot.panes?.find((pane) => pane.pane_id === paneId) ?? null;

  const focus = (paneId: string): boolean => {
    const pane = findPane(paneId);
    if (pane === null) return false;
    snapshot.focused_pane_id = pane.pane_id;
    snapshot.focused_tab_id = pane.tab_id;
    snapshot.focused_workspace_id = pane.workspace_id;
    for (const workspace of snapshot.workspaces ?? []) {
      workspace.focused = workspace.workspace_id === pane.workspace_id;
    }
    for (const tab of snapshot.tabs ?? []) {
      tab.focused = tab.tab_id === pane.tab_id;
    }
    for (const item of snapshot.panes ?? []) {
      item.focused = item.pane_id === pane.pane_id;
    }
    return true;
  };

  const closePane = (paneId: string): boolean => {
    if (findPane(paneId) === null) return false;
    snapshot.panes = (snapshot.panes ?? []).filter((pane) => pane.pane_id !== paneId);
    snapshot.agents = (snapshot.agents ?? []).filter((agent) => agent.pane_id !== paneId);
    outputs.delete(paneId);
    revisions.delete(paneId);

    const panes = snapshot.panes ?? [];
    snapshot.tabs = (snapshot.tabs ?? []).filter((tab) =>
      panes.some((pane) => pane.tab_id === tab.tab_id),
    );
    const tabs = snapshot.tabs ?? [];
    snapshot.workspaces = (snapshot.workspaces ?? []).filter((workspace) =>
      tabs.some((tab) => tab.workspace_id === workspace.workspace_id),
    );

    if (snapshot.focused_pane_id === paneId) {
      const next = panes[0] ?? null;
      if (next === null) {
        snapshot.focused_pane_id = null;
        snapshot.focused_tab_id = null;
        snapshot.focused_workspace_id = null;
      } else {
        focus(next.pane_id);
      }
    }
    return true;
  };

  const handle = (socket: net.Socket, line: string) => {
    let message: WireRequest;
    try {
      message = JSON.parse(line) as WireRequest;
    } catch {
      return;
    }
    const id = typeof message.id === "string" ? message.id : "";
    const params = (message.params ?? {}) as Record<string, unknown>;

    switch (message.method) {
      case "session.snapshot":
        send(socket, { id, result: { type: "session_snapshot", snapshot } });
        return;
      case "events.subscribe":
        subscribers.add(socket);
        send(socket, { id, result: { type: "subscription_started" } });
        return;
      case "pane.read": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        if (findPane(paneId) === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        send(socket, {
          id,
          result: {
            type: "pane_read",
            read: {
              pane_id: paneId,
              text: outputs.get(paneId) ?? "",
              truncated: false,
              revision: revisions.get(paneId) ?? 0,
            },
          },
        });
        return;
      }
      case "pane.send_input": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        if (findPane(paneId) === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        const text = typeof params.text === "string" ? params.text : "";
        outputs.set(paneId, `${outputs.get(paneId) ?? ""}${text}\n`);
        revisions.set(paneId, (revisions.get(paneId) ?? 0) + 1);
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.updated", { pane_id: paneId });
        return;
      }
      case "agent.focus": {
        const paneId = typeof params.target === "string" ? params.target : "";
        if (!focus(paneId)) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.focused", { pane_id: paneId });
        return;
      }
      case "pane.close": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        if (!closePane(paneId)) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.closed", { pane_id: paneId });
        return;
      }
      default:
        send(socket, {
          id,
          error: { code: "invalid_params", message: `unknown method: ${String(message.method)}` },
        });
    }
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      subscribers.delete(socket);
    });

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        if (line.trim()) handle(socket, line);
      }
      if (buffer.length > MAX_MESSAGE_CHARS) {
        buffer = "";
        socket.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    root,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
