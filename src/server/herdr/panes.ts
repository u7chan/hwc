import { isAttachmentName, MAX_ATTACHMENTS } from "../../shared/attachments";
import {
  type AgentKind,
  type AgentModel,
  isAgentKind,
  isAgentEffort,
  isAgentModel,
  supportsModelSelection,
} from "../../shared/agents";
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

// Herdr の `lines` は uint32。上限を超える値は Herdr 側で弾かれるので、こちらで 400 にする。
const MAX_LINES = 4_294_967_295;

// ペインへの入力を丸ごとソケットへ流す前に止める。手元の長文プロンプトには十分な大きさ。
export const MAX_TEXT_BYTES = 16_384;

export const TEXT_TOO_LONG = `text must be at most ${MAX_TEXT_BYTES} bytes`;
export const TEXT_WITH_ATTACHMENTS_TOO_LONG = `text and the attached files note must be at most ${MAX_TEXT_BYTES} bytes`;

// 分割直後のペインは、シェルの準備ができるまで agent.start が agent_pane_busy を返す。
const AGENT_PANE_WAIT_MS = 5_000;
const AGENT_PANE_RETRY_MS = 150;

export type PaneOutput = PaneRead;

// ペイン名は Herdr のラベルと同じ上限に合わせる。空文字は「名前なし」として null にする。
export const MAX_PANE_NAME = 80;

export type SplitRequest = {
  name: string | null;
  agent: AgentKind | null;
  model?: AgentModel | null;
  effort?: string | null;
};

export type ReadOptions = { paneId: string; source: ReadSource; lines?: number };

export type SendOptions = { paneId: string; text: string; submit: boolean };

export type InputBody = { text: string; submit: boolean; attachments: string[] };

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
};

export type RenameOptions = { paneId: string; label: string };

// Herdr のエージェント名は小文字英数字・-・_ の 1〜32 文字。ペイン名は日本語や空白を
// 許すので、エージェント名はペイン id から別に作る。表示名は pane.rename の label に置く。
export function agentNameForPane(paneId: string): string {
  const base = `hwc-${paneId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return base.slice(0, 32);
}

export type PaneClient = {
  read: (options: ReadOptions) => Promise<PaneOutput>;
  send: (options: SendOptions) => Promise<void>;
  focus: (options: FocusOptions) => Promise<void>;
  stop: (options: StopOptions) => Promise<void>;
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

export type Parsed<T> = { ok: true; value: T } | { ok: false; status: 400 | 413; error: string };

export function parseSplitBody(body: unknown): Parsed<SplitRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be an object" };
  }

  const record = body as Record<string, unknown>;
  const rawName = record.name;
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
    return { ok: false, status: 400, error: "name must be a string" };
  }
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if ([...name].length > MAX_PANE_NAME) {
    return { ok: false, status: 400, error: `name must be at most ${MAX_PANE_NAME} characters` };
  }

  const rawAgent = record.agent;
  if (rawAgent !== undefined && rawAgent !== null && !isAgentKind(rawAgent)) {
    return { ok: false, status: 400, error: "agent must be one of pi, claude, codex, opencode" };
  }

  const model = record.model ?? null;
  if (model !== null && (!supportsModelSelection(rawAgent) || !isAgentModel(model))) {
    return { ok: false, status: 400, error: "model must identify a Pi, Codex, or OpenCode model" };
  }

  const effort = record.effort ?? null;
  if (effort !== null && (model === null || !isAgentEffort(effort))) {
    return {
      ok: false,
      status: 400,
      error: "effort requires an explicit model and a non-empty value",
    };
  }

  return {
    ok: true,
    value: {
      name: name === "" ? null : name,
      agent: rawAgent == null ? null : rawAgent,
      model,
      effort,
    },
  };
}

export function parseOutputQuery(params: URLSearchParams): Parsed<Omit<ReadOptions, "paneId">> {
  const rawSource = params.get("source");
  if (rawSource !== null && !READ_SOURCES.includes(rawSource as ReadSource)) {
    return { ok: false, status: 400, error: `source must be one of ${READ_SOURCES.join(", ")}` };
  }
  const source = (rawSource ?? "recent") as ReadSource;

  const rawLines = params.get("lines");
  if (rawLines === null) return { ok: true, value: { source } };

  const lines = Number(rawLines);
  // Herdr は 0 も受理するが、0 行の出力を求める意味は無いので BFF で弾く。
  if (!/^\d+$/.test(rawLines) || lines < 1 || lines > MAX_LINES) {
    return { ok: false, status: 400, error: `lines must be an integer between 1 and ${MAX_LINES}` };
  }
  return { ok: true, value: { source, lines } };
}

export function parseInputBody(body: unknown): Parsed<InputBody> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be an object" };
  }

  const record = body as Record<string, unknown>;
  if (typeof record.text !== "string") {
    return { ok: false, status: 400, error: "text must be a string" };
  }

  const attachments = parseAttachments(record.attachments);
  if (attachments === null) {
    return { ok: false, status: 400, error: "attachments must be an array of attachment names" };
  }
  // 枚数の上限はメッセージ単位。1 枚の大きさはアップロード側で見る。
  if (attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, status: 400, error: `attachments must be at most ${MAX_ATTACHMENTS}` };
  }
  // 画像だけを送れるようにする。本文も添付も無いメッセージは送らない。
  if (record.text.trim() === "" && attachments.length === 0) {
    return { ok: false, status: 400, error: "text must be a non-empty string" };
  }
  if (record.submit !== undefined && typeof record.submit !== "boolean") {
    return { ok: false, status: 400, error: "submit must be a boolean" };
  }

  return { ok: true, value: { text: record.text, submit: record.submit === true, attachments } };
}

function parseAttachments(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isAttachmentName(item)) return null;
    names.push(item);
  }
  return names;
}

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

type Caller = <T>(
  method: string,
  params?: unknown,
  options?: { path?: string; timeoutMs?: number },
) => Promise<T>;

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

  return {
    async read({ paneId, source, lines }) {
      const result = await call<unknown>(
        "pane.read",
        { pane_id: paneId, source, format: "text", ...(lines === undefined ? {} : { lines }) },
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
    async stop({ paneId }) {
      // Herdr は Esc を esc として受ける。文字は送らず、キーだけを 1 回送る。
      await call("pane.send_keys", { pane_id: paneId, keys: ["esc"] }, { path });
    },
    async clear({ paneId }) {
      // 画面とスクロールバックを消すだけで、PTY には何も送らない。実行中のコマンドは止まらない。
      await call("pane.clear", { pane_id: paneId }, { path });
    },
    async confirmFolderTrust({ paneId }) {
      await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] }, { path });
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
    async startAgent({ paneId, kind, name, args, timeoutMs = 30_000 }) {
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
