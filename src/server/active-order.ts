import { join } from "node:path";
import { createJsonStore, createStateFile, type JsonStore, type StateFile } from "./state-file";

// アクティブ一覧の帯（スペース）の表示順。Herdr の並びとは別に、hwc が見え方として持つ。
// 全端末で同じ順にするため状態ディレクトリに置き、SSE の状態に載せる
// （docs/adr/state-storage.md）。
export type ActiveOrderFile = StateFile;

export function activeOrderPath(root: string): string {
  return join(root, "active-order.json");
}

export function createActiveOrderFile(root: string): ActiveOrderFile {
  return createStateFile(activeOrderPath(root));
}

// id は閉じたスペースの分も残り得る。並びとして読めるものだけを通し、読めない値で
// 一覧を止めない（docs/adr/state-storage.md）。
export const MAX_ACTIVE_ORDER = 500;

export function parseActiveOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item === "" || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
    if (ids.length >= MAX_ACTIVE_ORDER) break;
  }
  return ids;
}

export type ActiveOrderStore = JsonStore<string[]>;

export function createActiveOrderStore(file: ActiveOrderFile): ActiveOrderStore {
  return createJsonStore(file, [], parseActiveOrder);
}

// 画面に出ている帯の全 id を、上から順にそのまま受け取る。差分の当て方は持たない。
export type ParsedActiveOrderBody = { ok: true; value: string[] } | { ok: false; error: string };

export function parseActiveOrderBody(body: unknown): ParsedActiveOrderBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }

  const raw = (body as Record<string, unknown>).workspaceIds;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((id) => typeof id === "string" && id !== "")
  ) {
    return { ok: false, error: "workspaceIds must be a non-empty array of strings" };
  }
  if (raw.length > MAX_ACTIVE_ORDER) {
    return { ok: false, error: `workspaceIds must be at most ${MAX_ACTIVE_ORDER}` };
  }

  const workspaceIds = raw as string[];
  if (new Set(workspaceIds).size !== workspaceIds.length) {
    return { ok: false, error: "workspaceIds must be unique" };
  }
  return { ok: true, value: workspaceIds };
}
