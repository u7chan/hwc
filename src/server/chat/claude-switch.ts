import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_ID } from "./claude-sidecar";

// BFF が許可の印を置いてから `/model` を送り、hook が確認ダイアログを許可して、切り替えの完了を
// 記録する。ファイルは 1 本ずつ別の書き手にし、BFF と hook が同じファイルを読み書きして
// 競合しないようにする（docs/adr/claude-integration.md）。
//   <session id>.allow.json  BFF が書く。hook は読むだけ（完了で消す）
//   <session id>.done.json   hook が書く。BFF が読んで消す

// 印は 1 回の切り替えのためのもの。`/model` を送ってから CLI が hook を呼ぶまでは 1 秒に
// 満たないので、これより古い印は、消し損ねた残骸として使わない。
export const SWITCH_ALLOW_TTL_MS = 15_000;

const SWITCH_VERSION = 1;

// 1 件は数百バイト。これを超えるファイルは書き手が違う。
const MAX_BYTES = 4096;

export type SwitchAllow = { v: 1; sessionId: string; model: string; until: number };

// to_model は CLI が解決したモデル id（`claude-opus-5-5`）。requested は頼んだエイリアス。
export type SwitchDone = { v: 1; sessionId: string; at: number; model: string; requested: string };

export function switchRoot(stateRoot: string): string {
  return join(stateRoot, "claude", "model-switch");
}

function pathOf(root: string, sessionId: string, kind: "allow" | "done"): string | null {
  return SESSION_ID.test(sessionId) ? join(root, `${sessionId}.${kind}.json`) : null;
}

// 一時ファイルを経由して置き換え、読む側が途中の内容を見ないようにする。
async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// BFF が呼ぶ。`/model` を送る直前に、頼むエイリアスを印にする。
export async function writeAllow(
  root: string,
  sessionId: string,
  model: string,
  now: number,
): Promise<void> {
  const path = pathOf(root, sessionId, "allow");
  if (path === null) throw new Error("invalid session id");
  const allow: SwitchAllow = {
    v: SWITCH_VERSION,
    sessionId,
    model,
    until: now + SWITCH_ALLOW_TTL_MS,
  };
  await writeAtomic(path, allow);
}

export async function clearSwitch(root: string, sessionId: string): Promise<void> {
  for (const kind of ["allow", "done"] as const) {
    const path = pathOf(root, sessionId, kind);
    if (path !== null) await rm(path, { force: true });
  }
}

// 期限が切れた・別のセッションの・形の違う印は無いものとして扱う。
async function readAllow(
  root: string,
  sessionId: string,
  now: number,
): Promise<SwitchAllow | null> {
  const path = pathOf(root, sessionId, "allow");
  const record = path === null ? null : await readJson(path);
  if (record === null || record.v !== SWITCH_VERSION || record.sessionId !== sessionId) return null;
  const { model, until } = record;
  if (typeof model !== "string" || model === "") return null;
  if (typeof until !== "number" || !Number.isFinite(until) || until < now) return null;
  return { v: SWITCH_VERSION, sessionId, model, until };
}

// BFF が呼ぶ。`since` より前に書かれた記録は、前の切り替えのものなので返さない。
export async function readDone(
  root: string,
  sessionId: string,
  since: number,
): Promise<SwitchDone | null> {
  const path = pathOf(root, sessionId, "done");
  const record = path === null ? null : await readJson(path);
  if (record === null || record.v !== SWITCH_VERSION || record.sessionId !== sessionId) return null;
  const { at, model, requested } = record;
  if (typeof at !== "number" || !Number.isFinite(at) || at < since) return null;
  if (typeof model !== "string" || model === "") return null;
  if (typeof requested !== "string" || requested === "") return null;
  return { v: SWITCH_VERSION, sessionId, at, model, requested };
}

// hook プロセスが呼ぶ。PreModelSwitch には、印のあるコマンドだけ「許可」を返し、確認ダイアログを
// 開かせない。印の無い切り替え（端末で打った `/model`、ピッカー、自動の切り替え）は何も返さず、
// CLI の既定の確認に任せる。PostModelSwitch は、頼んだ切り替えが済んだことを記録する。
// CLI は 1 回の `/model` で PreModelSwitch を 2 回呼ぶ（to_model が違う）ので、照合は
// requested_model で行う。戻り値は hook の標準出力に書く文字列。
export async function applySwitchHook(
  root: string,
  input: unknown,
  now: number,
): Promise<string | null> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const { hook_event_name: event, session_id: sessionId } = record;
  if (event !== "PreModelSwitch" && event !== "PostModelSwitch") return null;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;

  const allow = await readAllow(root, sessionId, now);
  if (allow === null) return null;
  if (record.source !== "command" || record.requested_model !== allow.model) return null;

  if (event === "PreModelSwitch") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreModelSwitch",
        permissionDecision: "allow",
        permissionDecisionReason: "Confirmed in hwc",
      },
    });
  }

  const toModel = record.to_model;
  if (typeof toModel !== "string" || toModel === "") return null;
  const done: SwitchDone = {
    v: SWITCH_VERSION,
    sessionId,
    at: now,
    model: toModel,
    requested: allow.model,
  };
  const path = pathOf(root, sessionId, "done");
  if (path !== null) await writeAtomic(path, done);
  const allowPath = pathOf(root, sessionId, "allow");
  if (allowPath !== null) await rm(allowPath, { force: true });
  return null;
}
