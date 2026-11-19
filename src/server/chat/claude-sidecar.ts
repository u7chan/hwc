import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ASK_USER_QUESTION,
  parsePending,
  questionPending,
  toolPending,
  toolSummary,
} from "./claude-pending";
import type { ChatPending } from "./contract";

// セッション id は hook の入力から来る。ファイル名に使うので、パスを跨ぐ値を弾く。
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// 質問は人が席に戻るまで何時間も待つ。これより古い sidecar は、消し損ねた残骸として無視する。
export const SIDECAR_TTL_MS = 24 * 60 * 60 * 1000;

// 1 件は数 KB。これを超えるファイルは hook が書いたものではない。
const MAX_SIDECAR_BYTES = 256 * 1024;

const SIDECAR_VERSION = 1;

// hook が書く最後のツール 1 件。承認待ちと分かったときだけ pending を持つ。
// 内容は表示に必要な正規化済みの項目だけで、tool_input 全体は保存しない。
export type Sidecar = {
  v: typeof SIDECAR_VERSION;
  sessionId: string;
  at: number;
  toolUseId: string;
  tool: string;
  pending: ChatPending | null;
};

export type HookAction = { kind: "write"; sidecar: Sidecar } | { kind: "clear" } | { kind: "none" };

// hook を受けて、sidecar をどうするかを決める。PermissionRequest は tool_use_id を持たないので、
// 直前の PreToolUse が書いたツールと突き合わせて id を引き継ぐ（同じ session・同じ tool 名のとき
// だけ。並列呼び出しで別のツールの行になっていたら、誤った id を付けずにカードを出さない）。
export function nextSidecar(input: unknown, current: Sidecar | null, now: number): HookAction {
  const record = asRecord(input);
  if (record === null) return none;
  const sessionId = record.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return none;
  // サブエージェントのツールは、本流の待ちとは別の流れ。本流のカードを上書きしない。
  if (record.agent_id !== undefined) return none;
  const owned = current?.sessionId === sessionId ? current : null;

  switch (record.hook_event_name) {
    case "PreToolUse": {
      const { tool_use_id: toolUseId, tool_name: tool } = record;
      if (!isNonEmpty(toolUseId) || !isNonEmpty(tool)) return none;
      // 質問は、ダイアログが開くこと自体が人間待ち。承認と違い、PermissionRequest を待たない。
      const pending =
        tool === ASK_USER_QUESTION ? questionPending(toolUseId, record.tool_input) : null;
      return write({ sessionId, at: now, toolUseId, tool, pending });
    }
    case "PermissionRequest": {
      const tool = record.tool_name;
      if (!isNonEmpty(tool) || tool === ASK_USER_QUESTION) return none;
      if (owned === null || owned.tool !== tool) return none;
      const pending = toolPending(owned.toolUseId, tool, toolSummary(tool, record.tool_input));
      return pending === null ? none : write({ ...owned, at: now, pending });
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      // 並列のツールが先に終わっても、別のツールの待ちを消さない。
      return owned !== null && record.tool_use_id === owned.toolUseId ? clear : none;
    // ターンが進んだ・終わった・セッションが閉じた。Esc で閉じた待ちは、tool の hook が
    // 何も呼ばないので、次の発言（またはターンの終わり）まで残る。
    case "UserPromptSubmit":
    case "Stop":
    case "SessionEnd":
      return clear;
    default:
      return none;
  }
}

const none: HookAction = { kind: "none" };
const clear: HookAction = { kind: "clear" };

function write(fields: Omit<Sidecar, "v">): HookAction {
  return { kind: "write", sidecar: { v: SIDECAR_VERSION, ...fields } };
}

// 状態ディレクトリの下の置き場。hook と BFF が同じ場所を見る。
export function sidecarRoot(stateRoot: string): string {
  return join(stateRoot, "claude", "pending");
}

export function sidecarPath(root: string, sessionId: string): string | null {
  return SESSION_ID.test(sessionId) ? join(root, `${sessionId}.json`) : null;
}

// BFF が読む。形が合わない・大きすぎる・別のセッションのものは無いものとして扱う。
export async function readSidecar(root: string, sessionId: string): Promise<Sidecar | null> {
  const path = sidecarPath(root, sessionId);
  if (path === null) return null;
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SIDECAR_BYTES) return null;
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return parseSidecar(text, sessionId);
}

export function parseSidecar(text: string, sessionId: string): Sidecar | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (record === null || record.v !== SIDECAR_VERSION || record.sessionId !== sessionId) {
    return null;
  }
  const { at, toolUseId, tool } = record;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (!isNonEmpty(toolUseId) || !isNonEmpty(tool)) return null;
  const pending = record.pending === null ? null : parsePending(record.pending);
  // 壊れた pending は、待ちが読めないものとして扱う。ツールの記録としては残す。
  return { v: SIDECAR_VERSION, sessionId, at, toolUseId, tool, pending };
}

// hook プロセスが呼ぶ。書き込みは一時ファイルを経由して置き換え、BFF が途中の行を読まない
// ようにする。
export async function applyHook(root: string, input: unknown, now: number): Promise<void> {
  const sessionId = asRecord(input)?.session_id;
  if (typeof sessionId !== "string") return;
  const path = sidecarPath(root, sessionId);
  if (path === null) return;

  const action = nextSidecar(input, await readSidecar(root, sessionId), now);
  if (action.kind === "clear") {
    await rm(path, { force: true });
    return;
  }
  if (action.kind === "none") return;

  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(action.sidecar), { mode: 0o600 });
  await rename(temporary, path);
  await pruneStale(root, now);
}

// 閉じ損ねたセッションの残骸が溜まらないようにする。書くときだけ掃除する。
async function pruneStale(root: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (info !== null && now - info.mtimeMs > SIDECAR_TTL_MS) await rm(path, { force: true });
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
