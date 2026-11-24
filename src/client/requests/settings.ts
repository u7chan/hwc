import type { AgentSkills } from "../../shared/agent-skills";
import {
  type AgentModel,
  type ModelAgentKind,
  type ModelLabels,
  isAgentEffort,
  isAgentModel,
} from "../../shared/agents";
import {
  type LaunchDefault,
  type LaunchDefaults,
  parseLaunchDefaults,
} from "../../shared/launch-defaults";
import {
  type NotificationScope,
  type NotificationView,
  parseNotificationView,
} from "../../shared/notifications";
import { parseRestartSettings, type RestartSettings } from "../../shared/restart";
import { parseTemplates, type Template } from "../../shared/templates";
import { type BodyResponse, client, paneParam, toErrorText } from "../api";

export function toAgentModels(value: unknown): AgentModel[] | null {
  if (typeof value !== "object" || value === null) return null;
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models) || !models.every(isAgentModel)) return null;
  return models.map(({ provider, id }) => ({ provider, id }));
}

export type AgentModelsRead = AgentModel[] | "opencode_not_running" | null;

export function agentModelsOutcome(status: number, value: unknown): AgentModelsRead {
  if (
    status === 502 &&
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error === "opencode_not_running"
  )
    return "opencode_not_running";
  return status >= 200 && status < 300 ? toAgentModels(value) : null;
}

export function toModelLabels(value: unknown): ModelLabels | null {
  if (typeof value !== "object" || value === null) return null;
  const labels = (value as { labels?: unknown }).labels;
  if (labels === null) return null;
  if (typeof labels !== "object" || Array.isArray(labels)) return null;
  const parsed: ModelLabels = {};
  for (const [key, label] of Object.entries(labels)) {
    if (key !== "" && typeof label === "string" && label !== "") parsed[key] = label;
  }
  return parsed;
}

// Claude の alias を表示名に解決する。候補とは別の口なので、読めなくても選べる。
export async function readModelLabels(signal: AbortSignal): Promise<ModelLabels | null> {
  try {
    const init = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
    const response = await client.api["model-labels"].$get(
      { query: { agent: "claude" } },
      { init },
    );
    return response.status === 200 ? toModelLabels(await response.json()) : null;
  } catch {
    return null;
  }
}

// paneId が null のときは設定画面の候補で、BFF がホームディレクトリで読む。
export async function readAgentModels(
  paneId: string | null,
  agent: ModelAgentKind,
  signal: AbortSignal,
): Promise<AgentModelsRead> {
  try {
    const init = { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) };
    const query = { query: { agent } };
    const response =
      paneId === null
        ? await client.api.models.$get(query, { init })
        : await client.api.panes[":id"].models.$get({ ...paneParam(paneId), ...query }, { init });
    return agentModelsOutcome(response.status, await response.json());
  } catch {
    return null;
  }
}

export function toAgentEfforts(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null) return null;
  const efforts = (value as { efforts?: unknown }).efforts;
  if (!Array.isArray(efforts) || !efforts.every(isAgentEffort)) return null;
  return [...new Set(efforts)];
}

export async function readAgentEfforts(
  paneId: string | null,
  agent: ModelAgentKind,
  model: AgentModel,
  signal: AbortSignal,
): Promise<string[] | null> {
  try {
    const init = { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) };
    const query = { query: { agent, provider: model.provider, model: model.id } };
    const response =
      paneId === null
        ? await client.api.efforts.$get(query, { init })
        : await client.api.panes[":id"].efforts.$get({ ...paneParam(paneId), ...query }, { init });
    if (!response.ok) return null;
    return toAgentEfforts(await response.json());
  } catch {
    return null;
  }
}

export function toLaunchDefaults(value: unknown): LaunchDefaults | null {
  if (typeof value !== "object" || value === null) return null;
  const defaults = (value as { defaults?: unknown }).defaults;
  if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) return null;
  return parseLaunchDefaults(defaults);
}

// 読めなかったときは null。作成ダイアログは既定なしとして開く。
export async function readLaunchDefaults(signal: AbortSignal): Promise<LaunchDefaults | null> {
  try {
    const response = await client.api["launch-defaults"].$get(
      {},
      { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) } },
    );
    if (!response.ok) return null;
    return toLaunchDefaults(await response.json());
  } catch {
    return null;
  }
}

export type LaunchDefaultSaveResult = { ok: true; defaults: LaunchDefaults } | { ok: false };

// その CLI がグローバルに認識するスキル。読めなかったときは null（保存値ではなく、毎回読む）。
export async function readAgentSkills(
  agent: ModelAgentKind,
  signal: AbortSignal,
): Promise<AgentSkills | null> {
  try {
    const response = await client.api.agents[":agent"].skills.$get(
      { param: { agent } },
      { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) } },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// value が null なら、そのエージェントの既定を解除する。
export async function saveLaunchDefault(
  agent: ModelAgentKind,
  value: LaunchDefault | null,
): Promise<LaunchDefaultSaveResult> {
  try {
    const response = await client.api["launch-defaults"].$put({ json: { agent, value } });
    if (!response.ok) return { ok: false };
    const defaults = toLaunchDefaults(await response.json());
    return defaults === null ? { ok: false } : { ok: true, defaults };
  } catch {
    return { ok: false };
  }
}

export type NotificationSaveResult =
  | { ok: true; view: NotificationView }
  | { ok: false; error: string | null };

// テスト送信は BFF が Discord の応答を待つ。BFF に届かないときにボタンが送信中のまま
// 残らないよう、外側にもう少し長い期限を置く。
export const TEST_NOTIFICATION_TIMEOUT_MS = 15_000;

async function toSaveResult(response: BodyResponse): Promise<NotificationSaveResult> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const view = parseNotificationView(body);
    return view === null ? { ok: false, error: null } : { ok: true, view };
  }
  return { ok: false, error: toErrorText(body, null) };
}

export async function fetchNotifications(signal?: AbortSignal): Promise<NotificationView> {
  const response = await client.api.notifications.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`notifications: ${response.status}`);
  const view = parseNotificationView(await response.json().catch(() => null));
  if (view === null) throw new Error("notifications: unexpected body");
  return view;
}

export async function saveNotificationSettings(input: {
  enabled: boolean;
  scope: NotificationScope;
}): Promise<NotificationSaveResult> {
  try {
    const response = await client.api.notifications.$put({ json: input });
    return await toSaveResult(response);
  } catch {
    return { ok: false, error: null };
  }
}

export async function saveDiscordWebhook(url: string): Promise<NotificationSaveResult> {
  try {
    const response = await client.api.notifications.discord.$put({ json: { url } });
    return await toSaveResult(response);
  } catch {
    return { ok: false, error: null };
  }
}

export async function removeDiscordWebhook(): Promise<NotificationSaveResult> {
  try {
    const response = await client.api.notifications.discord.$delete({});
    return await toSaveResult(response);
  } catch {
    return { ok: false, error: null };
  }
}

export type NotificationTestResult = { ok: true } | { ok: false; error: string };

// 状態ではなく BFF が返す error コードで文言を決める。BFF の 404 と Discord の 404 は
// 別物で、ここではどちらもコードに畳まれている。
export async function testDiscordWebhook(): Promise<NotificationTestResult> {
  try {
    // body は読まれないが、415 を避けて application/json を付ける。
    const response = await client.api.notifications.discord.test.$post(
      {},
      {
        headers: { "content-type": "application/json" },
        init: { signal: AbortSignal.timeout(TEST_NOTIFICATION_TIMEOUT_MS) },
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true };
    return { ok: false, error: toErrorText(body, "unknown") };
  } catch {
    // 期限切れと接続失敗はクライアント側でしか分からない。文言はコードで選ぶ。
    return { ok: false, error: "unreachable" };
  }
}

export async function fetchRestartSettings(signal?: AbortSignal): Promise<RestartSettings> {
  const response = await client.api.restart.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`restart: ${response.status}`);
  return parseRestartSettings(await response.json().catch(() => null));
}

export type RestartSaveResult =
  | { ok: true; view: RestartSettings }
  | { ok: false; error: string | null };

export async function saveRestartSettings(input: {
  command: string | null;
  afterPull: boolean;
}): Promise<RestartSaveResult> {
  try {
    const response = await client.api.restart.$put({ json: input });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, view: parseRestartSettings(body) };
    return { ok: false, error: toErrorText(body, null) };
  } catch {
    return { ok: false, error: null };
  }
}

export type RunRestartResult = "started" | "not_configured" | "not_executable" | "unreachable";

// 起動したかどうかだけを返す。コマンドが HWC を再起動する構成なら、この応答の直後に
// 接続が切れ、ページは自動で読み直される。
export async function runRestart(): Promise<RunRestartResult> {
  try {
    // body は読まれないが、BFF は application/json 以外を 415 で弾く。
    const response = await client.api.restart.$post({ json: {} });
    if (response.ok) return "started";
    const error = toErrorText(await response.json().catch(() => null), null);
    if (error === "command_not_configured") return "not_configured";
    if (error === "command_not_executable") return "not_executable";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function fetchTemplates(signal?: AbortSignal): Promise<Template[] | null> {
  try {
    const response = await client.api.templates.$get({}, { init: { signal } });
    if (!response.ok) return null;
    const body = (await response.json()) as { templates?: unknown };
    return parseTemplates(body.templates);
  } catch {
    return null;
  }
}

export type TemplateSaveResult =
  | { ok: true; templates: Template[] }
  | { ok: false; error: string | null };

export async function saveTemplates(templates: Template[]): Promise<TemplateSaveResult> {
  try {
    const response = await client.api.templates.$put({ json: { templates } });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed =
        typeof body === "object" && body !== null
          ? parseTemplates((body as { templates?: unknown }).templates)
          : null;
      return parsed === null ? { ok: false, error: null } : { ok: true, templates: parsed };
    }
    return { ok: false, error: toErrorText(body, null) };
  } catch {
    return { ok: false, error: null };
  }
}
