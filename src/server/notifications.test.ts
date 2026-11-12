import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus } from "./herdr/contract";
import { type AppState, NO_TIMES, type PaneState, type WorkspaceState } from "./herdr/state";
import type { PullRequest } from "../shared/pull-request";
import type { NotificationSettings } from "../shared/notifications";
import type { PullRequestReader } from "./pull-request";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../shared/notifications";
import {
  blockedNotificationContent,
  blockedPaneIds,
  createDiscordSender,
  createNotificationDispatcher,
  createNotificationSettingsFile,
  createNotificationSettingsStore,
  isSettledWorkspace,
  notificationPaneLabel,
  notificationSettingsPath,
  settledWorkspaceIds,
  toDiscordPayload,
  workspaceNotificationContent,
  type DiscordSendResult,
  type DiscordSender,
  type NotificationSettingsStore,
} from "./notifications";

const WEBHOOK = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwx-1234";
const PULL_URL = "https://github.com/example/acme-dashboard/pull/481";

function pane(id: string, agent: string | null, agentStatus: AgentStatus): PaneState {
  return {
    id,
    title: null,
    label: null,
    agent,
    agentStatus,
    focused: false,
    chat: agent !== null,
  };
}

function workspace(
  id: string,
  panes: PaneState[],
  extra: Partial<WorkspaceState> = {},
): WorkspaceState {
  return {
    id,
    label: id,
    agentStatus: "unknown",
    focused: false,
    worktree: null,
    tabs: [{ id: `${id}:t1`, label: "1", agentStatus: "unknown", focused: false, panes }],
    ...extra,
  };
}

function appState(workspaces: WorkspaceState[]): AppState {
  return {
    focusedWorkspaceId: null,
    focusedTabId: null,
    focusedPaneId: null,
    times: NO_TIMES,
    workspaces,
  };
}

// 親が done、子が done か idle の山。
function settledSpace(id = "w1", childStatus: AgentStatus = "done"): WorkspaceState {
  return workspace(id, [pane(`${id}:p1`, "pi", "done"), pane(`${id}:p2`, "codex", childStatus)], {
    branch: "feat/empty-state",
  });
}

function workingSpace(id = "w1"): WorkspaceState {
  return workspace(id, [pane(`${id}:p1`, "pi", "done"), pane(`${id}:p2`, "codex", "working")]);
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "hwc-notifications-"));
}

function createSettings(initial: Partial<NotificationSettings> = {}) {
  let current: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...initial };
  const store: NotificationSettingsStore = {
    get: () => current,
    save: (next) => {
      current = next;
    },
  };
  return {
    store,
    update: (patch: Partial<NotificationSettings>) => {
      current = { ...current, ...patch };
    },
  };
}

function createSender(result: DiscordSendResult | (() => Promise<DiscordSendResult>)) {
  const calls: Array<{ url: string; content: string }> = [];
  const sender: DiscordSender = async (url, content) => {
    calls.push({ url, content });
    return typeof result === "function" ? await result() : result;
  };
  return { sender, calls };
}

function createStateStore(initial: AppState, paths: Record<string, string> = {}) {
  let current = initial;
  return {
    store: {
      get: () => current,
      workspacePath: (workspaceId: string) => paths[workspaceId] ?? null,
    },
    set: (next: AppState) => {
      current = next;
    },
  };
}

function openPullRequest(): PullRequest {
  return {
    number: 481,
    url: PULL_URL,
    title: "Add an empty state to the dashboard",
    state: "OPEN",
  };
}

// 設定ファイル

test("settings live in the state directory as notifications.json", () => {
  expect(notificationSettingsPath("/state/hwc")).toBe("/state/hwc/notifications.json");
});

test("a missing or malformed settings file starts from the defaults", () => {
  const root = tempRoot();
  const file = createNotificationSettingsFile(root);
  expect(createNotificationSettingsStore(file).get()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);

  writeFileSync(join(root, "notifications.json"), "{not json");
  expect(createNotificationSettingsStore(file).get()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
});

test("valid items survive an invalid item in the settings file", () => {
  const root = tempRoot();
  writeFileSync(
    join(root, "notifications.json"),
    JSON.stringify({ enabled: true, scope: "all", discordWebhookUrl: "http://example.com/hook" }),
  );
  expect(createNotificationSettingsStore(createNotificationSettingsFile(root)).get()).toEqual({
    enabled: true,
    scope: "all",
    discordWebhookUrl: null,
  });
});

test("saving writes the settings with 0600 and leaves no temporary file", () => {
  const root = tempRoot();
  const store = createNotificationSettingsStore(createNotificationSettingsFile(root));
  const next: NotificationSettings = { enabled: true, scope: "all", discordWebhookUrl: WEBHOOK };
  store.save(next);

  const path = notificationSettingsPath(root);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(next);
  // 資格情報なので、同じユーザー以外から読めないようにする。
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(root)).toEqual(["notifications.json"]);
});

test("the temporary file name is unique per write and ignores a stale fixed tmp", () => {
  const root = tempRoot();
  // 固定名の tmp が残っていても書き込みを妨げない（ADR 0018 の pane-times とは別の形）。
  writeFileSync(join(root, "notifications.json.tmp"), "stale");
  const store = createNotificationSettingsStore(createNotificationSettingsFile(root));
  store.save({ enabled: false, scope: "pull-request", discordWebhookUrl: null });

  expect(readFileSync(join(root, "notifications.json.tmp"), "utf8")).toBe("stale");
  expect(JSON.parse(readFileSync(notificationSettingsPath(root), "utf8"))).toEqual({
    enabled: false,
    scope: "pull-request",
    discordWebhookUrl: null,
  });
});

test("a failed write keeps the old settings in memory", () => {
  const store = createNotificationSettingsStore({
    read: () => null,
    write: () => {
      throw new Error("disk full");
    },
  });
  expect(() => store.save({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK })).toThrow();
  expect(store.get()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
});

// Discord への送信

type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(response: Response | (() => Promise<Response>)) {
  const calls: FetchCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? await response() : response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

test("a successful post waits for the message and disables mentions", async () => {
  const { fetch, calls } = fakeFetch(new Response("", { status: 200 }));
  const sender = createDiscordSender({ fetch });

  expect(await sender(WEBHOOK, "hwc: done")).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(`${WEBHOOK}?wait=true`);
  expect(calls[0]?.init?.method).toBe("POST");
  // 3xx を追うと検証したホスト以外へ本文が渡りうる。
  expect(calls[0]?.init?.redirect).toBe("manual");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    content: "hwc: done",
    allowed_mentions: { parse: [] },
  });
});

test("204 is a success too", async () => {
  const sender = createDiscordSender({
    fetch: fakeFetch(new Response(null, { status: 204 })).fetch,
  });
  expect(await sender(WEBHOOK, "x")).toEqual({ ok: true });
});

test("the sender maps Discord responses to error codes", async () => {
  const cases: Array<[Response, DiscordSendResult]> = [
    [new Response("", { status: 401 }), { ok: false, error: "discord_invalid_webhook" }],
    [new Response("", { status: 403 }), { ok: false, error: "discord_invalid_webhook" }],
    [new Response("", { status: 404 }), { ok: false, error: "discord_invalid_webhook" }],
    [new Response("", { status: 400 }), { ok: false, error: "discord_unavailable" }],
    [new Response("", { status: 500 }), { ok: false, error: "discord_unavailable" }],
    [
      new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }),
      { ok: false, error: "discord_rate_limited", retryAfter: 1.5 },
    ],
    [
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
      { ok: false, error: "discord_rate_limited", retryAfter: 2 },
    ],
    [new Response("", { status: 429 }), { ok: false, error: "discord_rate_limited" }],
  ];
  for (const [response, expected] of cases) {
    const sender = createDiscordSender({ fetch: fakeFetch(response).fetch });
    expect(await sender(WEBHOOK, "x")).toEqual(expected);
  }
});

test("a redirect is not followed", async () => {
  const sender = createDiscordSender({
    fetch: fakeFetch(
      new Response("", { status: 302, headers: { location: "https://example.com/" } }),
    ).fetch,
  });
  expect(await sender(WEBHOOK, "x")).toEqual({ ok: false, error: "discord_unavailable" });
});

test("a network failure or timeout is reported as unavailable", async () => {
  const failing = createDiscordSender({
    fetch: (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch,
  });
  expect(await failing(WEBHOOK, "x")).toEqual({ ok: false, error: "discord_unavailable" });

  const slow = createDiscordSender({
    timeoutMs: 5,
    fetch: ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch,
  });
  expect(await slow(WEBHOOK, "x")).toEqual({ ok: false, error: "discord_unavailable" });
});

test("the E2E sink records the content instead of calling Discord", async () => {
  const root = tempRoot();
  const sinkPath = join(root, "discord-webhook.jsonl");
  const { fetch, calls } = fakeFetch(new Response("", { status: 500 }));
  const sender = createDiscordSender({ fetch, sinkPath });

  expect(await sender(WEBHOOK, "hwc: done")).toEqual({ ok: true });
  expect(calls).toEqual([]);
  const lines = readFileSync(sinkPath, "utf8").trim().split("\n");
  expect(lines.map((line) => JSON.parse(line))).toEqual([{ content: "hwc: done" }]);
});

test("the payload always disables mentions", () => {
  expect(toDiscordPayload("@everyone done")).toEqual({
    content: "@everyone done",
    allowed_mentions: { parse: [] },
  });
});

// settled の判定

test("a space is settled when its parent is done and every agent is done or idle", () => {
  expect(isSettledWorkspace(settledSpace("w1", "done"))).toBe(true);
  expect(isSettledWorkspace(settledSpace("w1", "idle"))).toBe(true);
});

test("a space with a working, blocked or unknown agent is not settled", () => {
  for (const status of ["working", "blocked", "unknown"] as const) {
    expect(isSettledWorkspace(settledSpace("w1", status))).toBe(false);
  }
});

test("a space whose parent is not done is not settled", () => {
  const idleParent = workspace("w1", [pane("w1:p1", "pi", "idle"), pane("w1:p2", "codex", "done")]);
  expect(isSettledWorkspace(idleParent)).toBe(false);
});

test("shell panes do not count, so a shell-only space is never settled", () => {
  const shellOnly = workspace("w1", [pane("w1:p1", null, "unknown")]);
  expect(isSettledWorkspace(shellOnly)).toBe(false);

  // シェルの unknown は、エージェント全員が done / idle なら妨げない。
  const withShell = workspace("w1", [
    pane("w1:p1", "pi", "done"),
    pane("w1:p2", null, "unknown"),
    pane("w1:p3", "codex", "idle"),
  ]);
  expect(isSettledWorkspace(withShell)).toBe(true);
});

test("settled ids are collected per space", () => {
  const state = appState([settledSpace("w1"), workingSpace("w2"), settledSpace("w3", "idle")]);
  expect([...settledWorkspaceIds(state)]).toEqual(["w1", "w3"]);
});

// 要対応の判定と本文

test("blocked ids are collected per pane and skip shell panes", () => {
  const state = appState([
    workspace("w1", [
      pane("w1:p1", "pi", "blocked"),
      pane("w1:p2", "codex", "working"),
      pane("w1:p3", null, "blocked"),
    ]),
    workspace("w2", [pane("w2:p1", "codex", "blocked")]),
  ]);
  expect([...blockedPaneIds(state)]).toEqual(["w1:p1", "w2:p1"]);
});

test("the blocked body names the workspace, the panes and the branch", () => {
  const panes = [
    { ...pane("w1:p1", "pi", "blocked"), label: "impl" },
    { ...pane("w1:p2", "codex", "blocked"), label: "  " },
  ];
  const labeled = workspace("w1", panes, {
    label: "acme-dashboard",
    branch: "feat/empty-state",
  });
  expect(blockedNotificationContent(labeled, panes)).toBe(
    "hwc: acme-dashboard が対応を待っています\nペイン: impl, codex\nブランチ: feat/empty-state",
  );

  // ブランチが読めないスペースでは行を出さない。
  const noBranch = workspace("w2", [pane("w2:p1", "pi", "blocked")]);
  expect(blockedNotificationContent(noBranch, noBranch.tabs[0]?.panes ?? [])).toBe(
    "hwc: w2 が対応を待っています\nペイン: pi",
  );

  // ラベルが無いペインはエージェント名、それも無ければ id で呼ぶ。
  expect(notificationPaneLabel(pane("w1:p9", "pi", "blocked"))).toBe("pi");
  expect(notificationPaneLabel(pane("w1:p9", null, "blocked"))).toBe("w1:p9");
});

test("the all-scope body uses the workspace label and the branch", () => {
  expect(workspaceNotificationContent(settledSpace("w1"))).toBe(
    "hwc: w1 が完了しました\nブランチ: feat/empty-state",
  );
  // ブランチが読めないスペースでは行を出さない。
  const noBranch = workspace("w2", [pane("w2:p1", "pi", "done")]);
  expect(workspaceNotificationContent(noBranch)).toBe("hwc: w2 が完了しました");
});

test("an empty label falls back to the repository name, then the id", () => {
  const labeled = workspace("w1", [pane("w1:p1", "pi", "done")], {
    label: "  ",
    worktree: {
      repoName: "acme-dashboard",
      repoRoot: "/work",
      checkoutPath: "/work/acme-dashboard",
      isLinkedWorktree: false,
      managed: true,
    },
  });
  expect(workspaceNotificationContent(labeled)).toBe("hwc: acme-dashboard が完了しました");
  const bare = workspace("w9", [pane("w9:p1", "pi", "done")], { label: "" });
  expect(workspaceNotificationContent(bare)).toBe("hwc: w9 が完了しました");
});

// 遷移と送信

// 本番の store は publish した状態を get で返す。テストでも同じ順に揃え、
// 送信直前の読み直しが最新の publish を見るようにする。
function createHarness(options: {
  initial: AppState;
  settings: NotificationSettingsStore;
  sender: DiscordSender;
  pullRequests?: PullRequestReader;
  log?: (message: string) => void;
  paths?: Record<string, string>;
}) {
  const stateStore = createStateStore(options.initial, options.paths ?? {});
  const dispatch = createNotificationDispatcher({
    store: stateStore.store,
    settings: options.settings,
    sender: options.sender,
    pullRequests: options.pullRequests,
    log: options.log,
  });
  return {
    set: stateStore.set,
    publish: (state: AppState, observed = true) => {
      stateStore.set(state);
      dispatch(state, observed);
    },
  };
}

test("the first publish only builds the baseline", async () => {
  const state = appState([settledSpace()]);
  const settings = createSettings({ enabled: true, discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(state);
  publish(state);
  await Bun.sleep(0);
  expect(calls).toEqual([]);
});

test("a child going from working to done sends once", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  // done のまま留まる間は再送しない。
  publish(appState([settledSpace()]));
  await Bun.sleep(0);

  expect(calls).toEqual([
    { url: WEBHOOK, content: "hwc: w1 が完了しました\nブランチ: feat/empty-state" },
  ]);
});

test("a child going done to idle is still settled and does not resend", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([settledSpace("w1", "done")]));
  publish(appState([settledSpace("w1", "idle")]));
  await Bun.sleep(0);

  expect(calls).toHaveLength(1);
});

test("after the parent leaves done, coming back to done sends again", async () => {
  const parentIdle = workspace("w1", [pane("w1:p1", "pi", "idle"), pane("w1:p2", "codex", "idle")]);
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  publish(appState([parentIdle]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);

  expect(calls).toHaveLength(2);
});

test("an unobserved publish never sends but updates the baseline", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  // 再接続直後は、落ちた遷移を観測していない。
  publish(appState([settledSpace()]), false);
  publish(appState([settledSpace()]));
  await Bun.sleep(0);

  expect(calls).toEqual([]);
});

// 要対応の遷移と送信

function blockedSpace(id = "w1"): WorkspaceState {
  return workspace(id, [pane(`${id}:p1`, "pi", "done"), pane(`${id}:p2`, "codex", "blocked")], {
    branch: "feat/empty-state",
  });
}

test("a pane entering blocked sends once, regardless of scope and PR", async () => {
  const settings = createSettings({
    enabled: true,
    scope: "pull-request",
    discordWebhookUrl: WEBHOOK,
  });
  const { sender, calls } = createSender({ ok: true });
  let reads = 0;
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
    paths: { w1: "/work/acme" },
    pullRequests: async () => {
      reads += 1;
      return null;
    },
  });

  const state = blockedSpace();
  publish(appState([workingSpace()]));
  publish(appState([state]));
  // blocked のまま留まる間は再送しない。
  publish(appState([state]));
  await Bun.sleep(0);

  expect(calls).toEqual([
    {
      url: WEBHOOK,
      content: "hwc: w1 が対応を待っています\nペイン: codex\nブランチ: feat/empty-state",
    },
  ]);
  // 要対応は PR の有無で絞らない。gh も呼ばない。
  expect(reads).toBe(0);
});

test("a pane that blocks again after unblocking sends again", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  const blocked = blockedSpace();
  publish(appState([workingSpace()]));
  publish(appState([blocked]));
  await Bun.sleep(0);
  publish(appState([workingSpace()]));
  publish(appState([blocked]));
  await Bun.sleep(0);

  expect(calls).toHaveLength(2);
});

test("an unobserved blocked transition never sends but updates the baseline", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([blockedSpace()]), false);
  publish(appState([blockedSpace()]));
  await Bun.sleep(0);

  expect(calls).toEqual([]);
});

test("blocked panes in one space are sent as one message", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  const both = workspace(
    "w1",
    [pane("w1:p1", "pi", "blocked"), pane("w1:p2", "codex", "blocked")],
    { branch: "feat/empty-state" },
  );
  publish(appState([workingSpace()]));
  publish(appState([both]));
  await Bun.sleep(0);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.content).toBe(
    "hwc: w1 が対応を待っています\nペイン: pi, codex\nブランチ: feat/empty-state",
  );
});

test("blocked panes are tracked while notifications are disabled", async () => {
  const settings = createSettings({ enabled: false, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([blockedSpace()]));
  // 有効化しても、既に blocked だったペインには遡らない。
  settings.update({ enabled: true });
  publish(appState([blockedSpace()]));
  await Bun.sleep(0);
  expect(calls).toEqual([]);

  // 解除して再び blocked になれば送る。
  publish(appState([workingSpace()]));
  publish(appState([blockedSpace()]));
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
});

test("settled spaces are tracked while notifications are disabled", async () => {
  const settings = createSettings({ enabled: false, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  // 有効化しても、既に settled だった山には遡らない。
  settings.update({ enabled: true });
  publish(appState([settledSpace()]));
  await Bun.sleep(0);
  expect(calls).toEqual([]);

  // 新しい山は送る。
  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
});

test("a missing webhook URL is tracked without sending", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: null });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);
  expect(calls).toEqual([]);
});

test("a settled space that is unsettled again is not sent", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);

  // 1 度収束した山が working に戻っただけでは、もう送らない。
  publish(appState([workingSpace()]));
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
});

test("a publish during a pending send does not send twice", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const calls: string[] = [];
  // 送信の完了をテストから解放する。代入前の呼び出しは何もしない。
  let release: () => void = () => {};
  const sender: DiscordSender = async (_url, content) => {
    calls.push(content);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true };
  };
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
  });

  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);
  // 送信待ちの間に同じ状態が publish されても、集合は判定と同時に更新済み。
  publish(appState([settledSpace()]));
  release();
  await Bun.sleep(0);

  expect(calls).toHaveLength(1);
});

test("the space and settings are read again just before sending", async () => {
  const settings = createSettings({
    enabled: true,
    scope: "pull-request",
    discordWebhookUrl: WEBHOOK,
  });
  const { sender, calls } = createSender({ ok: true });
  let release: (value: PullRequest | null) => void = () => {};
  const { publish, set } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
    paths: { w1: "/work/acme" },
    pullRequests: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });

  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);
  // PR を待つ間に別のエージェントが動き出したら送らない。
  set(appState([workingSpace()]));
  release(openPullRequest());
  await Bun.sleep(0);

  expect(calls).toEqual([]);
});

test("the PR scope sends only when the latest pull request is open", async () => {
  const run = async (pullRequest: PullRequest | null, rejects = false) => {
    const settings = createSettings({
      enabled: true,
      scope: "pull-request",
      discordWebhookUrl: WEBHOOK,
    });
    const { sender, calls } = createSender({ ok: true });
    const reads: Array<{ checkoutPath: string; branch: string; refresh?: boolean }> = [];
    const { publish } = createHarness({
      initial: appState([workingSpace()]),
      settings: settings.store,
      sender,
      paths: { w1: "/work/acme" },
      pullRequests: async (options) => {
        reads.push(options);
        if (rejects) throw new Error("gh failed");
        return pullRequest;
      },
    });
    publish(appState([workingSpace()]));
    publish(appState([settledSpace()]));
    await Bun.sleep(0);
    return { calls, reads };
  };

  const open = await run(openPullRequest());
  expect(open.calls).toEqual([
    {
      url: WEBHOOK,
      content: `hwc: PR #481 の作業が完了しました\nAdd an empty state to the dashboard\n${PULL_URL}`,
    },
  ]);
  // キャッシュを使わず、終わった時点の最新を引く。
  expect(open.reads).toEqual([
    { checkoutPath: "/work/acme", branch: "feat/empty-state", refresh: true },
  ]);

  // 最新が merged / closed なら送らない。古い open が残っていても同じ。
  expect((await run({ ...openPullRequest(), state: "MERGED" })).calls).toEqual([]);
  expect((await run({ ...openPullRequest(), state: "CLOSED" })).calls).toEqual([]);
  // PR が無い・gh で確認できないときも送らない。再試行もしない。
  expect((await run(null)).calls).toEqual([]);
  expect((await run(null, true)).calls).toEqual([]);
});

test("the PR scope needs a branch and a checkout to ask gh", async () => {
  const settings = createSettings({
    enabled: true,
    scope: "pull-request",
    discordWebhookUrl: WEBHOOK,
  });
  const { sender, calls } = createSender({ ok: true });
  let reads = 0;
  const noBranch = workspace("w1", [pane("w1:p1", "pi", "done"), pane("w1:p2", "codex", "done")]);
  const { publish } = createHarness({
    // ブランチもチェックアウトも無いスペース。
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
    pullRequests: async () => {
      reads += 1;
      return openPullRequest();
    },
  });
  publish(appState([workingSpace()]));
  publish(appState([noBranch]));
  await Bun.sleep(0);

  expect(reads).toBe(0);
  expect(calls).toEqual([]);
});

test("the all scope does not ask for pull requests", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  const { sender, calls } = createSender({ ok: true });
  let reads = 0;
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
    paths: { w1: "/work/acme" },
    pullRequests: async () => {
      reads += 1;
      return openPullRequest();
    },
  });
  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);

  expect(reads).toBe(0);
  expect(calls).toHaveLength(1);
});

test("a failing send is logged once while it keeps failing, without the URL", async () => {
  const settings = createSettings({ enabled: true, scope: "all", discordWebhookUrl: WEBHOOK });
  let result: DiscordSendResult = { ok: false, error: "discord_unavailable" };
  const { sender } = createSender(async () => result);
  const logs: string[] = [];
  const { publish } = createHarness({
    initial: appState([workingSpace()]),
    settings: settings.store,
    sender,
    log: (message) => logs.push(message),
  });

  const mountains = 3;
  for (let index = 0; index < mountains; index += 1) {
    publish(appState([workingSpace()]));
    publish(appState([settledSpace()]));
    await Bun.sleep(0);
  }
  expect(logs).toEqual(["discord notification: discord_unavailable"]);
  expect(logs.join("")).not.toContain("discord.com");

  // 成功したら、次の失敗はまた 1 回だけ出す。
  result = { ok: true };
  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);
  result = { ok: false, error: "discord_rate_limited" };
  publish(appState([workingSpace()]));
  publish(appState([settledSpace()]));
  await Bun.sleep(0);

  expect(logs).toEqual([
    "discord notification: discord_unavailable",
    "discord notification: discord_rate_limited",
  ]);
});
