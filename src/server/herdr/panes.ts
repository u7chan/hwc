import { asRecord } from "../../shared/json";
import { IDLE_PANE_PROCESS, type PaneProcess } from "../../shared/panes";
import { listeningPorts } from "../ports";
import type { AgentKind } from "../../shared/agents";
import {
  type PaneLayout,
  type PaneRead,
  parsePaneLayout,
  parsePaneDirectory,
  parsePaneRead,
  parsePaneSplit,
} from "./contract";
import type { SplitDirection } from "./split";
import { HerdrError, request } from "./socket";

export const READ_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
export type ReadSource = (typeof READ_SOURCES)[number];

// ペインへの入力を丸ごとソケットへ流す前に止める。手元の長文プロンプトには十分な大きさ。
export const MAX_TEXT_BYTES = 16_384;

export const TEXT_TOO_LONG = `text must be at most ${MAX_TEXT_BYTES} bytes`;
export const TEXT_WITH_ATTACHMENTS_TOO_LONG = `text and the attached files note must be at most ${MAX_TEXT_BYTES} bytes`;

// 分割直後のペインは、シェルの準備ができるまで agent.start が agent_pane_busy を返す。
const AGENT_PANE_WAIT_MS = 5_000;
const AGENT_PANE_RETRY_MS = 150;

export type PaneOutput = PaneRead;

export type SendKeysOptions = { paneId: string; keys: string[] };

export type ReadOptions = { paneId: string; source: ReadSource; lines?: number };

export type SendOptions = { paneId: string; text: string; submit: boolean };

export type FocusOptions = { paneId: string };

export type StopOptions = { paneId: string };

export type ClearOptions = { paneId: string };

export type CloseOptions = { paneId: string };

export type LayoutOptions = { paneId: string };

export type SplitOptions = { paneId: string; direction: SplitDirection; ratio: number };

export type AgentStartOptions = {
  paneId: string;
  kind: AgentKind;
  name: string;
  args?: string[];
  timeoutMs?: number;
  // 分割直後はシェルが起動を受け付けるまで agent_pane_busy が返るので待つ。既存のシェルへ
  // 起動するときは、同じ code が「コマンドが動いている」を意味するので待たない。
  waitForShell?: boolean;
};

export type RenameOptions = { paneId: string; label: string };

// Herdr のエージェント名は小文字英数字・-・_ の 1〜32 文字。ペイン名は日本語や空白を
// 許すので、エージェント名はペイン id から別に作る。表示名は pane.rename の label に置く。
export function agentNameForPane(paneId: string): string {
  const base = `hwc-${paneId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return base.slice(0, 32);
}

// 同じペインで起動し直すと、前回のエージェント名が Herdr 側に残っていないか分からない。
// 名前は Herdr の照会用で hwc はペイン id しか使わないため、起動のたびに変えてよい。
export function restartAgentName(paneId: string, now: number = Date.now()): string {
  const base = agentNameForPane(paneId).slice(0, 27);
  return `${base}-${now.toString(36).slice(-4).padStart(4, "0")}`;
}

export type PaneClient = {
  read: (options: ReadOptions) => Promise<PaneOutput>;
  send: (options: SendOptions) => Promise<void>;
  // キーだけを送る。文字は送らない。キー名は Herdr のもの（`esc`、`enter`、`C-c`）。
  sendKeys: (options: SendKeysOptions) => Promise<void>;
  focus: (options: FocusOptions) => Promise<void>;
  stop: (options: StopOptions) => Promise<void>;
  interrupt: (options: StopOptions) => Promise<void>;
  process: (options: StopOptions) => Promise<PaneProcess>;
  clear: (options: ClearOptions) => Promise<void>;
  confirmFolderTrust: (options: { paneId: string }) => Promise<void>;
  close: (options: CloseOptions) => Promise<void>;
  exit: (options: CloseOptions) => Promise<void>;
  layout: (options: LayoutOptions) => Promise<PaneLayout>;
  directory: (options: { paneId: string }) => Promise<string>;
  split: (options: SplitOptions) => Promise<{ paneId: string }>;
  startAgent: (options: AgentStartOptions) => Promise<void>;
  rename: (options: RenameOptions) => Promise<void>;
};

// 上限は注記を組み立てた後の本文で測る。文字数ではなくバイト数。
export function exceedsTextLimit(text: string): boolean {
  return new TextEncoder().encode(text).length > MAX_TEXT_BYTES;
}

export function isPaneNotFound(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "pane_not_found";
}

export function isInvalidRequest(error: unknown): boolean {
  return (
    error instanceof HerdrError &&
    (error.code === "invalid_params" || error.code === "invalid_request")
  );
}

// 初回の trust / login 待ちで Herdr が返す。エージェント自体は起動している。
export function isAgentNotReady(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "agent_not_ready";
}

// ペインのシェルが起動を受け付けられない。分割直後（準備待ち）と、前景のコマンドが
// 動いている場合の両方で返る。
export function isAgentPaneBusy(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "agent_pane_busy";
}

type Caller = <T>(
  method: string,
  params?: unknown,
  options?: { path?: string; timeoutMs?: number },
) => Promise<T>;

// Herdr の managed launch は、状態変化か agent.get の照会でしか完了判定が進まない。
// hwc は起動後に問い合わせないため、idle のまま画面が動かないペインでは launch が
// pending に残り、数分後でも agent.prompt が agent_not_ready で拒否され続ける。
// Herdr CLI も agent.get を繰り返して待つ。送信可否の判定は agent.prompt が持つので、
// 照会の失敗では止めない。
// 追加の照会で終了の期限を削らないよう、この 1 回だけ短く切る。
const LAUNCH_RECONCILE_TIMEOUT_MS = 2_000;

async function reconcileAgentLaunch(call: Caller, paneId: string, path?: string) {
  try {
    await call("agent.get", { target: paneId }, { path, timeoutMs: LAUNCH_RECONCILE_TIMEOUT_MS });
  } catch {
    // 準備完了かどうかは agent.prompt が改めて判定する。
  }
}

// タブ名に出すので、長いコマンド行はここで切る。表示側の幅は CSS の省略に任せる。
const MAX_COMMAND_CHARS = 200;

// 前景プロセス群のうち最も深い（最後の）コマンド行を表示に使う。`bun run dev` の下に
// `bun --watch src/server.ts` がいる場合、利用者が知りたいのは後者。待ち受けポートは
// ここで見つけた pid から引く。
export type ProcessInfo = { process: PaneProcess; pids: number[] };

export function parseProcessInfo(value: unknown, paneId: string): ProcessInfo {
  const idle: ProcessInfo = { process: IDLE_PANE_PROCESS, pids: [] };
  const result = asRecord(value);
  if (result === null || result.type !== "pane_process_info") return idle;
  const info = asRecord(result.process_info);
  if (info === null || info.pane_id !== paneId) return idle;

  const shell = info.shell_pid;
  const foreground = info.foreground_process_group_id;
  if (typeof shell !== "number" || typeof foreground !== "number" || shell === foreground) {
    return idle;
  }

  const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
  const pids = processes
    .map((entry) => asRecord(entry)?.pid)
    .filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0);

  for (let index = processes.length - 1; index >= 0; index -= 1) {
    const cmdline = asRecord(processes[index])?.cmdline;
    if (typeof cmdline === "string" && cmdline.trim() !== "") {
      return {
        process: { running: true, command: cmdline.trim().slice(0, MAX_COMMAND_CHARS), ports: [] },
        pids,
      };
    }
  }
  return { process: { running: true, command: null, ports: [] }, pids };
}

function hasParentShell(value: unknown, paneId: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.type !== "pane_process_info") return false;
  if (typeof result.process_info !== "object" || result.process_info === null) return false;
  const info = result.process_info as Record<string, unknown>;
  const shell = info.shell_pid;
  const foreground = info.foreground_process_group_id;
  return (
    info.pane_id === paneId &&
    typeof shell === "number" &&
    Number.isInteger(shell) &&
    shell > 0 &&
    typeof foreground === "number" &&
    Number.isInteger(foreground) &&
    foreground > 0 &&
    shell !== foreground
  );
}

export function createPaneClient(options: { path?: string; call?: Caller } = {}): PaneClient {
  const { path } = options;
  const call: Caller = options.call ?? request;
  const sendKeys = ({ paneId, keys }: SendKeysOptions) =>
    call("pane.send_keys", { pane_id: paneId, keys }, { path }).then(() => undefined);

  return {
    async read({ paneId, source, lines }) {
      const result = await call<unknown>(
        "pane.read",
        {
          pane_id: paneId,
          source,
          format: "ansi",
          strip_ansi: false,
          ...(lines === undefined ? {} : { lines }),
        },
        { path },
      );
      return parsePaneRead(result, paneId);
    },
    async send({ paneId, text, submit }) {
      // 文字と Enter を 1 リクエストで送る。2 回に分けると、間で失敗したときに
      // 文字だけが残って再送で重複する。
      const params = submit
        ? { pane_id: paneId, text, keys: ["enter"] }
        : { pane_id: paneId, text };
      await call("pane.send_input", params, { path });
    },
    async focus({ paneId }) {
      // target はエージェント名も受けるが、hwc が持つのはペイン id だけ。
      await call("agent.focus", { target: paneId }, { path });
    },
    sendKeys,
    // Herdr は Esc を esc として受ける。文字は送らず、キーだけを 1 回送る。
    stop: ({ paneId }) => sendKeys({ paneId, keys: ["esc"] }),
    // シェルの前景プロセスを止める。Herdr のキー名は C-c で、PTY に SIGINT として届く。
    interrupt: ({ paneId }) => sendKeys({ paneId, keys: ["C-c"] }),
    async process({ paneId }) {
      const result = await call<unknown>("pane.process_info", { pane_id: paneId }, { path });
      const { process, pids } = parseProcessInfo(result, paneId);
      if (!process.running) return process;
      return { ...process, ports: await listeningPorts(pids) };
    },
    async clear({ paneId }) {
      // 画面とスクロールバックを消すだけで、PTY には何も送らない。実行中のコマンドは止まらない。
      await call("pane.clear", { pane_id: paneId }, { path });
    },
    async confirmFolderTrust({ paneId }) {
      await sendKeys({ paneId, keys: ["enter"] });
    },
    async close({ paneId }) {
      // ペインを閉じるとエージェントのプロセスも終わる。開いていた作業は戻らない。
      await call("pane.close", { pane_id: paneId }, { path });
    },
    async exit({ paneId }) {
      // exec などで PTY 直下のエージェントを終了すると、スペースまで消えてしまう。
      const info = await call("pane.process_info", { pane_id: paneId }, { path });
      if (!hasParentShell(info, paneId)) {
        throw new HerdrError("agent_exit_unsafe", "cannot confirm a parent shell");
      }
      await reconcileAgentLaunch(call, paneId, path);
      // agent.prompt は実プロセスも検査し、シェルや要対応の画面への誤送信を拒否する。
      await call("agent.prompt", { target: paneId, text: "/quit" }, { path });
    },
    async layout({ paneId }) {
      // 追加先を決めるためのセルの形だけを読む。タブの並びは変えない。
      const result = await call<unknown>("pane.layout", { pane_id: paneId }, { path });
      return parsePaneLayout(result);
    },
    async directory({ paneId }) {
      const result = await call<unknown>("pane.get", { pane_id: paneId }, { path });
      return parsePaneDirectory(result, paneId);
    },
    async split({ paneId, direction, ratio }) {
      // focus は既定の false のまま。TUI を見ている人のフォーカスを奪わない。
      // cwd も指定せず、Herdr の terminal.new_cwd を分割元に追随させる。
      const result = await call<unknown>(
        "pane.split",
        { target_pane_id: paneId, direction, ratio },
        { path },
      );
      return parsePaneSplit(result);
    },
    async startAgent({ paneId, kind, name, args, timeoutMs = 30_000, waitForShell = true }) {
      // エージェントの起動は TUI の準備完了まで待つ。通常のソケット期限（8 秒）では
      // 足りないので、Herdr 側の期限より少し長く取る。
      const params = {
        pane_id: paneId,
        kind,
        name,
        timeout_ms: timeoutMs,
        ...(args === undefined ? {} : { args }),
      };
      const deadline = Date.now() + AGENT_PANE_WAIT_MS;
      for (;;) {
        try {
          await call("agent.start", params, { path, timeoutMs: timeoutMs + 5_000 });
          return;
        } catch (error) {
          // 分割直後はシェルの準備待ち。別のペインが使われている場合も同じ code なので、
          // 期限までだけ試し、それ以上は失敗として返す。
          if (
            !waitForShell ||
            !(error instanceof HerdrError) ||
            error.code !== "agent_pane_busy" ||
            Date.now() >= deadline
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, AGENT_PANE_RETRY_MS));
        }
      }
    },
    async rename({ paneId, label }) {
      // 起動後に付ける。表示名はユーザーが入れたものを優先する。
      await call("pane.rename", { pane_id: paneId, label }, { path });
    },
  };
}
