import type net from "node:net";
import { join } from "node:path";
import type { HerdrPane, HerdrSnapshot } from "../../src/server/herdr/contract";
import type { Scenario } from "../fixtures/scenario";

export type PendingPiSession = {
  path: string;
  cwd: string | null;
  provider: string;
  modelId: string;
  effort: string;
};

export type FakeContext = {
  root: string;
  snapshot: HerdrSnapshot;
  outputs: Map<string, string>;
  foreground: Map<string, { cmdline: string; listen: boolean }>;
  listeners: Map<string, { child: Bun.Subprocess; port: number }>;
  revisions: Map<string, number>;
  pendingPiSessions: Map<string, PendingPiSession>;
  sockets: Set<net.Socket>;
  subscribers: Set<net.Socket>;
  timers: Set<ReturnType<typeof setTimeout>>;
  send: (socket: net.Socket, message: unknown) => void;
  broadcast: (event: string, data?: unknown) => void;
  findPane: (paneId: string) => HerdrPane | null;
  foregroundJob: (paneId: string) => { pid: number; name: string; cmdline: string } | null;
  stopListener: (paneId: string) => void;
  startListener: (paneId: string) => Promise<void>;
  later: (fn: () => Promise<void>, ms: number) => void;
};

export function createContext(options: { root: string; scenario: Scenario }): FakeContext {
  const { root, scenario } = options;
  const snapshot = structuredClone(scenario.snapshot);
  const outputs = new Map(Object.entries(scenario.outputs));
  // シェルの前景コマンド。C-c で消え、プロンプトに戻る。
  const foreground = new Map(Object.entries(scenario.foreground));
  // 待ち受けるコマンドは実プロセスで動かす。pid とポートが本物になるので、BFF の
  // /proc 経由のポート検出を E2E でもそのまま通せる。
  const listeners = new Map<string, { child: Bun.Subprocess; port: number }>();
  const revisions = new Map<string, number>();
  // 実 pi は最初の user / assistant メッセージまでセッション JSONL を書かない（SessionManager の
  // _hasConversation ガード）。起動直後に会話からモデルを読めない状態を E2E でも再現する。
  const pendingPiSessions = new Map<
    string,
    { path: string; cwd: string | null; provider: string; modelId: string; effort: string }
  >();
  const sockets = new Set<net.Socket>();
  const subscribers = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const send = (socket: net.Socket, message: unknown) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  };

  const broadcast = (event: string, data: unknown = {}) => {
    for (const socket of subscribers) send(socket, { event, data });
  };

  const findPane = (paneId: string) =>
    snapshot.panes?.find((pane) => pane.pane_id === paneId) ?? null;

  // エージェントのペインは、実 Herdr と同じく前景グループがシェルと別になる。
  // シェルのペインは、何か動いていると fixture で指定したときだけ別グループになる。
  const foregroundJob = (paneId: string): { pid: number; name: string; cmdline: string } | null => {
    const job = foreground.get(paneId);
    if (job !== undefined) {
      const listener = listeners.get(paneId);
      return {
        pid: listener?.child.pid ?? 200,
        name: job.cmdline.split(" ")[0] ?? job.cmdline,
        cmdline: job.cmdline,
      };
    }
    const agent = snapshot.agents?.find((item) => item.pane_id === paneId)?.agent;
    return agent ? { pid: 200, name: agent, cmdline: agent } : null;
  };

  const stopListener = (paneId: string) => {
    const listener = listeners.get(paneId);
    if (listener === undefined) return;
    listeners.delete(paneId);
    listener.child.kill("SIGINT");
  };

  const startListener = async (paneId: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "fake-listen.ts")], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const port = await readPort(child.stdout);
    listeners.set(paneId, { child, port });
    // 端末出力の `{port}` を実リスナーのポートに合わせる。fixture の固定値と実ポートが
    // 食い違うと、検出結果が誤っているように見える。
    outputs.set(paneId, (outputs.get(paneId) ?? "").replaceAll("{port}", String(port)));
  };

  const readPort = async (stream: ReadableStream<Uint8Array>): Promise<number> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("fake listener exited before it reported a port");
      buffer += decoder.decode(value, { stream: true });
      const match = /port:(\d+)/.exec(buffer);
      if (match?.[1] !== undefined) {
        reader.releaseLock();
        return Number(match[1]);
      }
    }
  };

  const later = (fn: () => Promise<void>, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void fn();
    }, ms);
    timers.add(timer);
  };

  return {
    root,
    snapshot,
    outputs,
    foreground,
    listeners,
    revisions,
    pendingPiSessions,
    sockets,
    subscribers,
    timers,
    send,
    broadcast,
    findPane,
    foregroundJob,
    stopListener,
    startListener,
    later,
  };
}
