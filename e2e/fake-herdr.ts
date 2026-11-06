import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAgentKind } from "../src/shared/agents";
import { ATTACHED_FILES_OPEN } from "../src/shared/attachments";
import type { HerdrPane } from "../src/server/herdr/contract";
import {
  createScenario,
  type CodexFixture,
  STARTUP_MODELS,
  writeCodexThread,
} from "./fixtures/scenario";
import { startFakeOpencode } from "./fake-opencode";

type WireRequest = { id?: string; method?: string; params?: unknown };

export type FakeHerdr = {
  socketPath: string;
  root: string;
  close: () => Promise<void>;
};

const MAX_MESSAGE_CHARS = 1024 * 1024;

// 会話を残さない（または履歴を置き換える）コマンドは、user メッセージとして追記しない。
const COMMAND_TEXT = /^\/(?:new|compact)(?: |$)/;

// 実 Herdr のソケットに触れず、E2E で使う架空の状態だけを返す。プロトコルは BFF が
// 実際に使う範囲に絞り、本番コードのソケット経路をそのまま通す。
export async function startFakeHerdr(): Promise<FakeHerdr> {
  const root = await mkdtemp(join(tmpdir(), "hwc-e2e-"));
  const socketPath = join(root, "herdr.sock");
  const scenario = await createScenario(root);
  const opencode = await startFakeOpencode(root);
  const snapshot = structuredClone(scenario.snapshot);
  const outputs = new Map(Object.entries(scenario.outputs));
  const revisions = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  const subscribers = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let sendCount = 0;
  let compactionCount = 0;

  const send = (socket: net.Socket, message: unknown) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  };

  const broadcast = (event: string, data: unknown = {}) => {
    for (const socket of subscribers) send(socket, { event, data });
  };

  const findPane = (paneId: string) =>
    snapshot.panes?.find((pane) => pane.pane_id === paneId) ?? null;

  // 送った本文を架空セッションの user メッセージとして追記する。E2E で確定後の送信カードを
  // 確かめられるようにするためで、対象は agent_session を持つペインの通常本文だけ。
  const appendUserEntry = async (paneId: string, text: string): Promise<void> => {
    if (text.trim() === "") return;
    const session = findPane(paneId)?.agent_session ?? null;
    // 添付を持つペインの Enter は常に本文の送信になる（ADR 0018）。添付付きの `/compact` も
    // 本文として送られるので、コマンド扱いは注記が無いときだけ。
    const command = !text.includes(ATTACHED_FILES_OPEN) && COMMAND_TEXT.test(text.trim());
    if (command) return;
    if (session?.agent === "codex" && session.kind === "id" && session.value) {
      const path = join(root, "codex", "threads", `${session.value}.json`);
      const fixture = (await Bun.file(path).json()) as CodexFixture;
      sendCount += 1;
      fixture.turns.push({
        id: `turn_send_${sendCount}`,
        startedAt: Date.now() / 1000,
        items: [
          { type: "userMessage", id: `u${sendCount}`, content: [{ type: "text", text }] },
          { type: "agentMessage", id: `a${sendCount}`, text: "E2E: Codex の返答です。" },
        ],
      });
      await writeCodexThread(root, session.value, fixture.thread.model, fixture.turns);
      return;
    }
    const path = session?.kind === "path" ? session.value : null;
    if (path === null) return;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return;
    }
    // 現在の葉を親にする。fixture の最後のエントリ（t1）から伸ばす。
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const last = lines.at(-1);
    let parentId: string | null = null;
    if (last !== undefined) {
      try {
        const entry = JSON.parse(last) as { id?: unknown };
        parentId = typeof entry.id === "string" ? entry.id : null;
      } catch {
        parentId = null;
      }
    }
    sendCount += 1;
    const entry = {
      type: "message",
      id: `e2e-send-${sendCount}`,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: text, timestamp: Date.now() },
    };
    await appendFile(path, `${JSON.stringify(entry)}\n`);
  };

  const later = (fn: () => Promise<void>, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void fn();
    }, ms);
    timers.add(timer);
  };

  const setAgentStatus = (paneId: string, status: "working" | "idle") => {
    const pane = findPane(paneId);
    if (pane === null) return;
    pane.agent_status = status;
    const tab = snapshot.tabs?.find((item) => item.tab_id === pane.tab_id);
    if (tab) tab.agent_status = status;
    const workspace = snapshot.workspaces?.find((item) => item.workspace_id === pane.workspace_id);
    if (workspace) workspace.agent_status = status;
    broadcast("pane.updated", { pane_id: paneId });
  };

  // /compact の完了を架空セッションに追記する。最後の user メッセージを kept の先頭にし、
  // 圧縮の区切りが会話の時系列に置かれることを E2E で確かめられるようにする。
  const appendCompaction = async (paneId: string): Promise<boolean> => {
    const session = findPane(paneId)?.agent_session ?? null;
    const path = session?.kind === "path" ? session.value : null;
    if (path === null) return false;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return false;
    }
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    let parentId: string | null = null;
    let keptId: string | null = null;
    for (const line of lines) {
      let entry: { id?: unknown; type?: unknown; message?: { role?: unknown } };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (typeof entry.id !== "string") continue;
      parentId = entry.id;
      if (entry.type === "message" && entry.message?.role === "user") keptId = entry.id;
    }
    if (parentId === null || keptId === null) return false;
    compactionCount += 1;
    const entry = {
      type: "compaction",
      id: `e2e-compaction-${compactionCount}`,
      parentId,
      timestamp: new Date().toISOString(),
      summary: "E2E: 直前までの会話を圧縮しました。",
      firstKeptEntryId: keptId,
      tokensBefore: 48_000,
    };
    await appendFile(path, `${JSON.stringify(entry)}\n`);
    return true;
  };

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

  // 実 Herdr の分割結果そのものではなく、E2E でセルの形を返すための固定のグリッド。
  // 方向や比率の正しさは BFF の unit で確かめ、ここでは画面の流れだけを通す。
  const paneArea = { width: 240, height: 48 };

  const layout = (paneId: string) => {
    const pane = findPane(paneId);
    if (pane === null) return null;
    const panes = (snapshot.panes ?? []).filter((item) => item.tab_id === pane.tab_id);
    return {
      type: "pane_layout",
      layout: {
        workspace_id: pane.workspace_id,
        tab_id: pane.tab_id,
        zoomed: false,
        area: { x: 0, y: 0, ...paneArea },
        focused_pane_id: snapshot.focused_pane_id ?? pane.pane_id,
        panes: panes.map((item, index) => ({
          pane_id: item.pane_id,
          focused: item.pane_id === snapshot.focused_pane_id,
          rect: {
            x: Math.floor((paneArea.width * index) / panes.length),
            y: 0,
            width:
              Math.floor((paneArea.width * (index + 1)) / panes.length) -
              Math.floor((paneArea.width * index) / panes.length),
            height: paneArea.height,
          },
        })),
        splits: [],
      },
    };
  };

  const splitPane = (paneId: string): HerdrPane | null => {
    const target = findPane(paneId);
    if (target === null) return null;
    const next =
      Math.max(
        0,
        ...(snapshot.panes ?? [])
          .filter((pane) => pane.workspace_id === target.workspace_id)
          .map((pane) => Number(pane.pane_id.split(":").at(-1)?.replace("p", "") ?? 0)),
      ) + 1;
    const created: HerdrPane = {
      pane_id: `${target.workspace_id}:p${next}`,
      workspace_id: target.workspace_id,
      tab_id: target.tab_id,
      cwd: target.cwd ?? null,
      label: null,
      agent_status: "unknown",
      focused: false,
      agent_session: null,
    };
    snapshot.panes = [...(snapshot.panes ?? []), created];
    outputs.set(created.pane_id, "");
    revisions.set(created.pane_id, 0);
    return created;
  };

  const handle = async (socket: net.Socket, line: string) => {
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
      case "pane.process_info": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        if (findPane(paneId) === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        send(socket, {
          id,
          result: {
            type: "pane_process_info",
            process_info: { pane_id: paneId, shell_pid: 100, foreground_process_group_id: 200 },
          },
        });
        return;
      }
      case "agent.prompt": {
        const paneId = typeof params.target === "string" ? params.target : "";
        const pane = findPane(paneId);
        const agent = snapshot.agents?.find((item) => item.pane_id === paneId);
        if (pane === null || !isAgentKind(agent?.agent)) {
          send(socket, { id, error: { code: "agent_not_ready", message: paneId } });
          return;
        }
        if (pane.agent_status === "blocked") {
          send(socket, { id, error: { code: "agent_blocked", message: paneId } });
          return;
        }
        if (params.text !== "/quit") {
          send(socket, { id, error: { code: "invalid_params", message: "text" } });
          return;
        }
        setAgentStatus(paneId, "idle");
        pane.agent_status = "unknown";
        pane.agent_session = null;
        snapshot.agents = (snapshot.agents ?? []).filter((item) => item.pane_id !== paneId);
        outputs.set(paneId, "$ ");
        revisions.set(paneId, (revisions.get(paneId) ?? 0) + 1);
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.updated", { pane_id: paneId });
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
        const compact =
          !text.includes(ATTACHED_FILES_OPEN) && /^\/compact(?: |$)/.test(text.trim());
        if (compact) {
          send(socket, { id, result: { type: "ok" } });
          later(async () => {
            try {
              await appendCompaction(paneId);
            } catch {
              // 追記に失敗しても idle に戻す。E2E の状態を止めない。
            } finally {
              // 実 Herdr の pi 拡張は手動 compaction を working として報告しない。
              // ここでも working にせず、hwc のローカルな圧縮中表示を確かめる。
              setAgentStatus(paneId, "idle");
            }
          }, 1200);
          return;
        }
        await appendUserEntry(paneId, text);
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.updated", { pane_id: paneId });
        return;
      }
      case "pane.send_keys": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        const target = findPane(paneId);
        if (target === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        const keys = Array.isArray(params.keys)
          ? params.keys.filter((key): key is string => typeof key === "string")
          : [];
        if (
          keys.length === 1 &&
          keys[0] === "enter" &&
          outputs.get(paneId)?.includes("› 1. Trust and continue")
        ) {
          if (!target.agent_session) {
            const sessionId = `thread_${paneId.replaceAll(":", "_")}`;
            await writeCodexThread(root, sessionId, STARTUP_MODELS[0]!.id);
            target.agent_session = {
              agent: "codex",
              source: "herdr:codex",
              kind: "id",
              value: sessionId,
            };
          }
          outputs.set(paneId, "Codex is ready.\n");
          revisions.set(paneId, (revisions.get(paneId) ?? 0) + 1);
          setAgentStatus(paneId, "idle");
        }
        // 停止ボタンは Esc だけを送る。実 Herdr と同じく、実行中のエージェントは
        // idle に戻ったものとして次のスナップショットを作る。
        if (keys.some((key) => key === "esc" || key === "escape")) {
          target.agent_status = "idle";
          const tab = snapshot.tabs?.find((item) => item.tab_id === target.tab_id);
          if (tab) tab.agent_status = "idle";
          const workspace = snapshot.workspaces?.find(
            (item) => item.workspace_id === target.workspace_id,
          );
          if (workspace) workspace.agent_status = "idle";
        }
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
      case "pane.get": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        const pane = findPane(paneId);
        send(
          socket,
          pane === null
            ? { id, error: { code: "pane_not_found", message: paneId } }
            : { id, result: { type: "pane_info", pane } },
        );
        return;
      }
      case "pane.layout": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        const result = layout(paneId);
        if (result === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        send(socket, { id, result });
        return;
      }
      case "pane.split": {
        const paneId = typeof params.target_pane_id === "string" ? params.target_pane_id : "";
        const direction = params.direction;
        if (direction !== "right" && direction !== "down") {
          send(socket, { id, error: { code: "invalid_params", message: "direction" } });
          return;
        }
        const created = splitPane(paneId);
        if (created === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        send(socket, { id, result: { type: "pane_info", pane: created } });
        broadcast("pane.created", { pane_id: created.pane_id });
        return;
      }
      case "pane.rename": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        const pane = findPane(paneId);
        if (pane === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        pane.label = typeof params.label === "string" ? params.label : null;
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.updated", { pane_id: paneId });
        return;
      }
      case "agent.start": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        const pane = findPane(paneId);
        if (pane === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        const kind = params.kind;
        if (!isAgentKind(kind)) {
          send(socket, { id, error: { code: "invalid_params", message: "kind" } });
          return;
        }
        const name = typeof params.name === "string" ? params.name : kind;
        const args = Array.isArray(params.args)
          ? params.args.filter((arg): arg is string => typeof arg === "string")
          : [];
        outputs.set(paneId, `$ ${kind}${args.length === 0 ? "" : ` ${args.join(" ")}`}\n`);
        const modelIndex = args.indexOf("--model");
        const model =
          modelIndex < 0 ? STARTUP_MODELS[0]!.id : (args[modelIndex + 1] ?? STARTUP_MODELS[0]!.id);
        if (kind === "pi") {
          const thinkingIndex = args.indexOf("--thinking");
          const effort = thinkingIndex < 0 ? "high" : args[thinkingIndex + 1];
          const directory = join(root, "agent", "sessions", paneId.replaceAll(":", "_"));
          const path = join(directory, "session.jsonl");
          const selected =
            STARTUP_MODELS.find((item) => `${item.provider}/${item.id}` === model) ??
            STARTUP_MODELS[0]!;
          await mkdir(directory, { recursive: true });
          await writeFile(
            path,
            [
              {
                type: "session",
                version: 3,
                id: crypto.randomUUID(),
                cwd: pane.cwd,
                timestamp: "2026-01-01T09:00:00.000Z",
              },
              {
                type: "model_change",
                id: "m1",
                parentId: null,
                provider: selected.provider,
                modelId: selected.id,
              },
              { type: "thinking_level_change", id: "t1", parentId: "m1", thinkingLevel: effort },
            ]
              .map((item) => `${JSON.stringify(item)}\n`)
              .join(""),
          );
          pane.agent_session = { agent: "pi", source: "herdr:pi", kind: "path", value: path };
        }
        if (kind === "codex") {
          const sessionId = `thread_${paneId.replaceAll(":", "_")}`;
          const config = args.find((arg) => arg.startsWith("model_reasoning_effort="));
          const effort = config
            ? (JSON.parse(config.slice("model_reasoning_effort=".length)) as string)
            : "high";
          await writeCodexThread(root, sessionId, model, [], effort);
          pane.agent_session = {
            agent: "codex",
            source: "herdr:codex",
            kind: "id",
            value: sessionId,
          };
        }
        if (kind === "opencode" && args[0] === "--session" && args[1]) {
          pane.agent_session = {
            agent: "opencode",
            source: "herdr:opencode",
            kind: "id",
            value: args[1],
          };
        }
        // 起動待ちのスピナーを画面で確かめられるよう、少しだけ待つ。実 Herdr では
        // エージェントの TUI が準備できるまで待つ時間に相当する。
        await new Promise((resolve) => setTimeout(resolve, 400));
        snapshot.agents = [
          ...(snapshot.agents ?? []).filter((agent) => agent.pane_id !== paneId),
          {
            pane_id: paneId,
            workspace_id: pane.workspace_id,
            cwd: pane.cwd ?? null,
            agent: kind,
            terminal_title_stripped: name,
          },
        ];
        pane.agent_status = "idle";
        const tab = snapshot.tabs?.find((item) => item.tab_id === pane.tab_id);
        if (tab) tab.agent_status = "idle";
        const workspace = snapshot.workspaces?.find(
          (item) => item.workspace_id === pane.workspace_id,
        );
        if (workspace) workspace.agent_status = "idle";
        send(socket, {
          id,
          result: {
            type: "agent_started",
            agent: { pane_id: paneId, agent: kind, name },
            argv: [kind, ...args],
          },
        });
        broadcast("pane.updated", { pane_id: paneId });
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

  return {
    socketPath,
    root,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      opencode.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
