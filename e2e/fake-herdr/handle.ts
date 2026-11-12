import type net from "node:net";
import { join } from "node:path";
import { isAgentKind } from "../../src/shared/agents";
import { ATTACHED_FILES_OPEN } from "../../src/shared/attachments";
import { START_FAILS_MODEL_ID, STARTUP_MODELS, writeCodexThread } from "../fixtures/scenario";
import type { FakeContext } from "./context";
import type { Layout } from "./layout";
import type { Pi } from "./pi";
import type { Workspaces } from "./workspaces";

type WireRequest = { id?: string; method?: string; params?: unknown };

export function createHandle(
  ctx: FakeContext,
  pi: Pi,
  workspaces: Workspaces,
  paneLayouts: Layout,
) {
  const {
    root,
    snapshot,
    outputs,
    revisions,
    pendingPiSessions,
    subscribers,
    foreground,
    send,
    broadcast,
    findPane,
    foregroundJob,
    stopListener,
    later,
  } = ctx;
  const {
    focus,
    closePane,
    moveWorkspaceBlock,
    removeWorkspace,
    removeWorktree,
    createWorktree,
    setAgentStatus,
    refreshAggregates,
  } = workspaces;
  const { activityEpochs, appendCompaction, appendUserEntry, clearPiActivity, startPiActivity } =
    pi;
  const { layout, splitPane } = paneLayouts;

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
      case "pane.clear": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        if (findPane(paneId) === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        // 実 Herdr は画面とスクロールバックを消し、入力中の 1 行だけを残す。
        const lines = (outputs.get(paneId) ?? "").split("\n").filter((line) => line !== "");
        const prompt = lines.at(-1) ?? "";
        outputs.set(paneId, prompt === "" ? "" : `${prompt}\n`);
        revisions.set(paneId, (revisions.get(paneId) ?? 0) + 1);
        send(socket, { id, result: { type: "ok" } });
        return;
      }
      case "pane.process_info": {
        const paneId = typeof params.pane_id === "string" ? params.pane_id : "";
        if (findPane(paneId) === null) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        const job = foregroundJob(paneId);
        send(socket, {
          id,
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: paneId,
              shell_pid: 100,
              foreground_process_group_id: job === null ? 100 : job.pid,
              foreground_processes: [job ?? { pid: 100, name: "bash", cmdline: "/bin/bash" }],
            },
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
        // 実 Herdr と同じく、終了したエージェントの画面は消さずにシェルのプロンプトを足す。
        // hwc が終了を観測して pane.clear を送るので、E2E では消えた後の表示も確かめられる。
        const screen = outputs.get(paneId) ?? "";
        outputs.set(
          paneId,
          screen === "" || screen.endsWith("\n") ? `${screen}$ ` : `${screen}\n$ `,
        );
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
        // フィクスチャ専用の入力。実 Herdr には無い。既読を進めない限り idle にならない
        // done を E2E から作れるようにして、終了時刻の表示と端末間の一致を確かめる。
        if (text.trim() === "/done") {
          send(socket, { id, result: { type: "ok" } });
          setAgentStatus(paneId, "done");
          return;
        }
        // フィクスチャ専用の入力。許可待ちや質問で止まった状態を E2E から作る。
        // 実 Herdr では、ペインが人間の応答を待つと blocked になる。
        if (text.trim() === "/blocked") {
          send(socket, { id, result: { type: "ok" } });
          setAgentStatus(paneId, "blocked");
          return;
        }
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
        // 実 Pi の /reload はセッションに何も書かず、agent_status も変えない。
        // hwc が「送信中」を畳むことを確かめるため、ここでも working にしない。
        if (!text.includes(ATTACHED_FILES_OPEN) && text.trim() === "/reload") {
          send(socket, { id, result: { type: "ok" } });
          return;
        }
        await appendUserEntry(paneId, text);
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.updated", { pane_id: paneId });
        await startPiActivity(paneId);
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
        if (
          keys.length === 1 &&
          keys[0] === "enter" &&
          outputs.get(paneId)?.includes("Trust project folder?")
        ) {
          outputs.set(paneId, "› Ask pi to do anything\n");
          revisions.set(paneId, (revisions.get(paneId) ?? 0) + 1);
          setAgentStatus(paneId, "idle");
        }
        // 停止ボタンは Esc だけを送る。実 Herdr と同じく、実行中のエージェントは
        // idle に戻ったものとして次のスナップショットを作る。
        if (keys.some((key) => key === "esc" || key === "escape")) {
          activityEpochs.set(paneId, (activityEpochs.get(paneId) ?? 0) + 1);
          void clearPiActivity(paneId);
          target.agent_status = "idle";
          const tab = snapshot.tabs?.find((item) => item.tab_id === target.tab_id);
          if (tab) tab.agent_status = "idle";
          const workspace = snapshot.workspaces?.find(
            (item) => item.workspace_id === target.workspace_id,
          );
          if (workspace) workspace.agent_status = "idle";
        }
        // シェルの C-c は前景プロセスを止める。端末にも送ったキーを残す。
        if (keys.some((key) => key === "C-c")) {
          stopListener(paneId);
          foreground.delete(paneId);
          outputs.set(paneId, `${outputs.get(paneId) ?? ""}^C\n`);
          revisions.set(paneId, (revisions.get(paneId) ?? 0) + 1);
        }
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.updated", { pane_id: paneId });
        return;
      }
      case "agent.focus": {
        const paneId = typeof params.target === "string" ? params.target : "";
        const target = findPane(paneId);
        if (target === null || !focus(paneId)) {
          send(socket, { id, error: { code: "pane_not_found", message: paneId } });
          return;
        }
        send(socket, { id, result: { type: "ok" } });
        broadcast("pane.focused", { pane_id: paneId });
        // 実 Herdr は focus したペインの seen を進める。hwc が既読に使うのはこの 1 点で、
        // done だけが idle に戻る（working / blocked はそのまま）。
        if (target.agent_status === "done") {
          target.agent_status = "idle";
          refreshAggregates(target);
          broadcast("pane.updated", { pane_id: paneId });
        }
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
        // 起動失敗の分岐を画面で確かめるための架空モデル（docs/e2e.md）。
        // Pi は provider/id、Codex は id だけを渡す。どちらでも同じモデルとして扱う。
        if (args.some((arg) => arg.endsWith(START_FAILS_MODEL_ID))) {
          send(socket, { id, error: { code: "agent_spawn_failed", message: kind } });
          return;
        }
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
          pendingPiSessions.set(paneId, {
            path,
            cwd: pane.cwd ?? null,
            provider: selected.provider,
            modelId: selected.id,
            effort,
          });
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
      case "workspace.close": {
        const workspaceId = typeof params.workspace_id === "string" ? params.workspace_id : "";
        if (!removeWorkspace(workspaceId)) {
          send(socket, { id, error: { code: "workspace_not_found", message: workspaceId } });
          return;
        }
        // ファイルは消さず、スペースだけを閉じる。実 Herdr と同じくグループは閉じない。
        send(socket, {
          id,
          result: { type: "workspace_closed", workspace_id: workspaceId },
        });
        broadcast("workspace.closed", { workspace_id: workspaceId });
        return;
      }
      case "workspace.move_block": {
        const ids = params.workspace_ids;
        const before = params.before_workspace_id;
        if (
          !Array.isArray(ids) ||
          !ids.every((id) => typeof id === "string") ||
          (before !== undefined && before !== null && typeof before !== "string")
        ) {
          send(socket, { id, error: { code: "invalid_params", message: "workspace_ids" } });
          return;
        }
        const ordered = moveWorkspaceBlock(
          ids as string[],
          typeof before === "string" ? before : null,
        );
        if (ordered === null) {
          send(socket, { id, error: { code: "invalid_params", message: "workspace block" } });
          return;
        }
        send(socket, { id, result: { type: "workspace_list", workspaces: ordered } });
        broadcast("workspace.reordered", {
          workspace_ids: ids,
          before_workspace_id: typeof before === "string" ? before : null,
          workspaces: ordered,
        });
        return;
      }
      case "worktree.create": {
        const workspaceId = typeof params.workspace_id === "string" ? params.workspace_id : "";
        const workspace = (snapshot.workspaces ?? []).find(
          (item) => item.workspace_id === workspaceId,
        );
        if (workspace === undefined) {
          send(socket, { id, error: { code: "workspace_not_found", message: workspaceId } });
          return;
        }
        if (workspace.worktree?.is_linked_worktree === true) {
          send(socket, { id, error: { code: "linked_worktree_source", message: workspaceId } });
          return;
        }
        if (workspace.worktree == null) {
          send(socket, { id, error: { code: "not_git_worktree", message: workspaceId } });
          return;
        }
        const created = await createWorktree(workspaceId);
        if (created === null) {
          send(socket, { id, error: { code: "worktree_create_failed", message: workspaceId } });
          return;
        }
        // 端点の指定（branch / path / base）は受けない。hwc は focus だけを送る。
        send(socket, {
          id,
          result: {
            type: "worktree_created",
            workspace: created.workspace,
            tab: created.tab,
            root_pane: created.rootPane,
            worktree: created.workspace.worktree,
          },
        });
        broadcast("workspace.created", { workspace_id: created.workspace.workspace_id });
        broadcast("pane.created", { pane_id: created.rootPane.pane_id });
        return;
      }
      case "worktree.remove": {
        const workspaceId = typeof params.workspace_id === "string" ? params.workspace_id : "";
        const workspace = (snapshot.workspaces ?? []).find(
          (item) => item.workspace_id === workspaceId,
        );
        if (workspace === undefined) {
          send(socket, { id, error: { code: "workspace_not_found", message: workspaceId } });
          return;
        }
        if (workspace.worktree?.is_linked_worktree !== true) {
          send(socket, { id, error: { code: "not_linked_worktree", message: workspaceId } });
          return;
        }
        removeWorktree(workspaceId);
        send(socket, {
          id,
          result: {
            type: "worktree_removed",
            workspace_id: workspaceId,
            forced: params.force === true,
          },
        });
        broadcast("workspace.closed", { workspace_id: workspaceId });
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

  return handle;
}
