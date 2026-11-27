import { isCompactCommand, isNewSessionCommand } from "../../shared/agent-commands";
import { isStoredAttachmentName, MAX_ATTACHMENTS } from "../../shared/attachments";
import {
  type AgentKind,
  type AgentModel,
  isAgentEffort,
  isAgentKind,
  isAgentModel,
  supportsModelSelection,
} from "../../shared/agents";
import { READ_SOURCES, type ReadOptions, type ReadSource } from "../herdr/panes";
import type { SplitRequest, StartRequest } from "../create-pane";

// Herdr の `lines` は uint32。上限を超える値は Herdr 側で弾かれるので、こちらで 400 にする。
const MAX_LINES = 4_294_967_295;

// ペイン名は Herdr のラベルと同じ上限に合わせる。空文字は「名前なし」として null にする。
export const MAX_PANE_NAME = 80;

export type InputBody = { text: string; submit: boolean; attachments: string[] };

// OpenCode の TUI は先頭 `/` の入力を候補メニューにする。hwc が送る /new と /compact は
// 候補を開く Enter と確定する Enter の 2 回が必要なので、送信側で分ける。添付の注記が
// 後ろに付く本文はコマンドにならないため、添付があるときは対象外にする。
export function isOpencodeCommand(text: string, attachmentCount: number): boolean {
  if (attachmentCount > 0) return false;
  // 先頭の空白は TUI では本文の一部になる。コマンドの判定は trim する関数に合わせるが、
  // 2 回目の Enter は先頭が `/` のときだけ送る（本文の空送信を避ける）。
  if (!text.startsWith("/")) return false;
  return isNewSessionCommand(text) || isCompactCommand(text);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; status: 400 | 413; error: string };

function parsePaneName(record: Record<string, unknown>): Parsed<string | null> {
  const rawName = record.name;
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
    return { ok: false, status: 400, error: "name must be a string" };
  }
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if ([...name].length > MAX_PANE_NAME) {
    return { ok: false, status: 400, error: `name must be at most ${MAX_PANE_NAME} characters` };
  }
  return { ok: true, value: name === "" ? null : name };
}

export function parseSplitBody(body: unknown): Parsed<SplitRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be an object" };
  }

  const record = body as Record<string, unknown>;
  const name = parsePaneName(record);
  if (!name.ok) return name;

  const rawAgent = record.agent;
  if (rawAgent !== undefined && rawAgent !== null && !isAgentKind(rawAgent)) {
    return { ok: false, status: 400, error: "agent must be one of pi, claude, codex, opencode" };
  }
  const agent = isAgentKind(rawAgent) ? rawAgent : null;

  const selection = parseAgentSelection(record, agent);
  if (!selection.ok) return selection;

  return {
    ok: true,
    value: {
      name: name.value,
      agent,
      ...selection.value,
    },
  };
}

// ワークツリーの作成は root ペインに名前を付けるだけ。起動するエージェントは
// ペインができた後に /agent で指定する（docs/adr/agent-launch.md）。
export function parseWorktreeBody(body: unknown): Parsed<{ name: string | null }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be an object" };
  }
  const name = parsePaneName(body as Record<string, unknown>);
  return name.ok ? { ok: true, value: { name: name.value } } : name;
}

// フォルダから作るスペース。path はツリーの根からの相対パスで、実在の確認は BFF が
// realpath で行う。ここでは形だけを見る。根そのもの（空）は受けない。
export function parseCreateSpaceBody(body: unknown): Parsed<{ path: string; name: string | null }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be an object" };
  }
  const record = body as Record<string, unknown>;
  const path = record.path;
  if (
    typeof path !== "string" ||
    path === "" ||
    path.startsWith("/") ||
    !path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  ) {
    return { ok: false, status: 400, error: "path must be a relative directory path" };
  }
  const name = parsePaneName(record);
  return name.ok ? { ok: true, value: { path, name: name.value } } : name;
}

// 既存のシェルペインで起動する要求。名前は付け直さないので受け取らない。
export function parseStartBody(body: unknown): Parsed<StartRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be an object" };
  }

  const record = body as Record<string, unknown>;
  const agent = record.agent;
  if (!isAgentKind(agent)) {
    return { ok: false, status: 400, error: "agent must be one of pi, claude, codex, opencode" };
  }

  const selection = parseAgentSelection(record, agent);
  if (!selection.ok) return selection;

  const waitForShell = record.waitForShell ?? false;
  if (typeof waitForShell !== "boolean") {
    return { ok: false, status: 400, error: "waitForShell must be a boolean" };
  }

  return { ok: true, value: { agent, ...selection.value, waitForShell } };
}

// モデルと effort の整合は、分割で作る場合と既存のシェルで起動する場合で同じ。
function parseAgentSelection(
  record: Record<string, unknown>,
  agent: AgentKind | null,
): Parsed<{ model: AgentModel | null; effort: string | null }> {
  const model = record.model ?? null;
  if (model !== null && (!supportsModelSelection(agent) || !isAgentModel(model))) {
    return {
      ok: false,
      status: 400,
      error: "model must identify a Pi, Claude, Codex, or OpenCode model",
    };
  }

  const effort = record.effort ?? null;
  if (effort !== null && (model === null || !isAgentEffort(effort))) {
    return {
      ok: false,
      status: 400,
      error: "effort requires an explicit model and a non-empty value",
    };
  }

  return { ok: true, value: { model, effort } };
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
  // 添付は画像に限らない。本文も添付も無いメッセージは送らない。
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
    if (typeof item !== "string" || !isStoredAttachmentName(item)) return null;
    names.push(item);
  }
  return names;
}
