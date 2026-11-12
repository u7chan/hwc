import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScenario } from "./fixtures/scenario";
import { startFakeOpencode } from "./fake-opencode";
import { createContext } from "./fake-herdr/context";
import { createHandle } from "./fake-herdr/handle";
import { createLayout } from "./fake-herdr/layout";
import { createPi } from "./fake-herdr/pi";
import { createWorkspaces } from "./fake-herdr/workspaces";

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
  const opencode = await startFakeOpencode(root);
  const ctx = createContext({ root, scenario });
  const workspaces = createWorkspaces(ctx);
  const pi = createPi(ctx, workspaces.setAgentStatus);
  const paneLayouts = createLayout(ctx);
  const handle = createHandle(ctx, pi, workspaces, paneLayouts);
  const { sockets, subscribers, listeners, timers } = ctx;

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
        if (line.trim()) void handle(socket, line);
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

  for (const [paneId, job] of ctx.foreground) {
    if (job.listen) await ctx.startListener(paneId);
  }

  return {
    socketPath,
    root,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const listener of listeners.values()) listener.child.kill("SIGINT");
      listeners.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      opencode.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
