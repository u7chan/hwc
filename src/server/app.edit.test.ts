import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppState, PaneState } from "./herdr/state";
import type { ChatMessage } from "./chat/contract";
import { chatState, createFakeChat, createTestApp, emptyChat, waitFor } from "./app.test-helpers";

const messages: ChatMessage[] = [
  { id: "u1", role: "user", text: "one", at: 1 },
  { id: "a1", role: "agent", text: "answer", at: 2 },
  { id: "u2", role: "user", text: "edit me", at: 3 },
  { id: "a2", role: "agent", text: "old answer", at: 4 },
];

const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/home/dev/workspaces/hwc",
});

const entry = (type: string, id: string, parentId: string | null, fields: unknown) =>
  JSON.stringify({
    type,
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    ...(fields as object),
  });

const sessionLine = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
) =>
  entry("message", id, parentId, {
    message: { role, content: [{ type: "text", text }], timestamp: 1_700_000_000_000 },
  });

const markerLine = (requestId: string, targetId = "u2") =>
  entry("custom", `m-${requestId}`, "a1", {
    customType: "hwc-rewind",
    data: { v: 1, requestId, targetId, leafId: "a1" },
  });

let dir: string;
let sessionPath: string;

const panesState = (
  overrides: { agent?: string; agentStatus?: PaneState["agentStatus"] } = {},
): AppState => {
  const workspace = chatState.workspaces[0]!;
  const tab = workspace.tabs[0]!;
  const pane = tab.panes[0]!;
  return {
    ...chatState,
    workspaces: [
      {
        ...workspace,
        tabs: [
          {
            ...tab,
            panes: [
              {
                ...pane,
                agent: overrides.agent ?? pane.agent,
                agentStatus: overrides.agentStatus ?? pane.agentStatus,
              },
            ],
          },
        ],
      },
    ],
  };
};

const createEditApp = (
  options: {
    state?: AppState;
    canRewind?: boolean;
    timeoutMs?: number;
    onSend?: (text: string) => Promise<void> | void;
    onMarker?: () => void;
    markerTarget?: string;
    noMarker?: boolean;
    messages?: ChatMessage[];
    snapshotMessages?: () => ChatMessage[];
    leafId?: string;
  } = {},
) => {
  const sent: string[] = [];
  const { app, store } = createTestApp({
    state: options.state ?? chatState,
    chat: createFakeChat({
      snapshot: async () => {
        const shown = options.snapshotMessages?.() ?? options.messages ?? messages;
        return {
          ...emptyChat,
          messages: shown,
          canRewind: options.canRewind ?? true,
          leafId: options.leafId ?? shown[shown.length - 1]?.id,
        };
      },
    }),
    panes: {
      send: async ({ text }) => {
        sent.push(text);
        if (text.startsWith("/hwc-rewind ")) {
          const [, targetId, requestId] = text.split(" ");
          if (!options.noMarker) {
            await appendFile(
              sessionPath,
              `${markerLine(requestId!, options.markerTarget ?? targetId!)}\n`,
            );
          }
          options.onMarker?.();
        } else {
          await appendFile(
            sessionPath,
            `${sessionLine(`u-${sent.length}`, "m-1", "user", text)}\n`,
          );
        }
        await options.onSend?.(text);
      },
    },
    editMarkerTimeoutMs: options.timeoutMs ?? 2_000,
  });
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  return { app, store, sent };
};

const post = (app: ReturnType<typeof createEditApp>["app"], body: unknown) =>
  app.request("/api/panes/w1:p1/edit-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hwc-edit-"));
  sessionPath = join(dir, "session.jsonl");
  await mkdir(dir, { recursive: true });
  await writeFile(
    sessionPath,
    [
      header,
      sessionLine("u1", null, "user", "one"),
      sessionLine("a1", "u1", "assistant", "answer"),
      sessionLine("u2", "a1", "user", "edit me"),
      sessionLine("a2", "u2", "assistant", "old answer"),
    ].join("\n") + "\n",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("rewinds to the message, then sends the edited text", async () => {
  const { app, sent } = createEditApp();
  const response = await post(app, { messageId: "u2", requestId: "req-1", text: "edited" });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(sent).toEqual(["/hwc-rewind u2 req-1", "edited"]);
});

test("the same request is idempotent and the text is not sent twice", async () => {
  const { app, sent } = createEditApp();
  await post(app, { messageId: "u2", requestId: "req-1", text: "edited" });
  const retry = await post(app, { messageId: "u2", requestId: "req-1", text: "edited" });

  expect(retry.status).toBe(200);
  expect(sent).toEqual(["/hwc-rewind u2 req-1", "edited"]);
});

test("a replaced session does not reuse the old marker", async () => {
  let current = messages;
  const { app, sent, store } = createEditApp({ snapshotMessages: () => current });
  await post(app, { messageId: "u2", requestId: "req-1", text: "edited" });

  const otherPath = join(dir, "other.jsonl");
  await writeFile(otherPath, `${header}\n`);
  store.setChatSource("w1:p1", { agent: "pi", path: otherPath });
  current = [];
  const retry = await post(app, { messageId: "u2", requestId: "req-1", text: "again" });

  expect(retry.status).toBe(409);
  expect(await retry.json()).toEqual({ error: "not_editable" });
  expect(sent).toEqual(["/hwc-rewind u2 req-1", "edited"]);
});

test("a restarted BFF finds the marker and text in the session tail", async () => {
  const first = createEditApp();
  await post(first.app, { messageId: "u2", requestId: "req-1", text: "edited" });
  const second = createEditApp();
  const retry = await post(second.app, { messageId: "u2", requestId: "req-1", text: "edited" });

  expect(retry.status).toBe(200);
  expect(second.sent).toEqual([]);
});

test("an existing marker skips the rewind command and only sends the text", async () => {
  await appendFile(sessionPath, `${markerLine("req-1")}\n`);
  const { app, sent } = createEditApp();
  const response = await post(app, { messageId: "u2", requestId: "req-1", text: "edited" });

  expect(response.status).toBe(200);
  expect(sent).toEqual(["edited"]);
});

test("the text limit applies when the requestId is already known", async () => {
  await appendFile(sessionPath, `${markerLine("req-1")}\n`);
  const { app, sent } = createEditApp();
  const response = await post(app, {
    messageId: "u2",
    requestId: "req-1",
    text: "x".repeat(20_000),
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "text_too_long" });
  expect(sent).toEqual([]);
});

test("a marker without matching text sends the text and reports a failed send after rewinding", async () => {
  let pushed = false;
  const { app, sent, store } = createEditApp({
    onMarker: () => {
      if (!pushed) {
        pushed = true;
        store.push(panesState({ agentStatus: "working" }), false);
      }
    },
  });
  const response = await post(app, { messageId: "u2", requestId: "req-1", text: "edited" });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "send_failed", rewound: true });
  expect(sent).toEqual(["/hwc-rewind u2 req-1"]);
});

test("missing marker ends in edit_failed", async () => {
  const { app, sent } = createEditApp({ timeoutMs: 30, noMarker: true });
  const response = await post(app, {
    messageId: "u2",
    requestId: "req-1",
    text: "edited",
  });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "edit_failed" });
  expect(sent).toEqual(["/hwc-rewind u2 req-1"]);
});

test("edits a user message whose leaf is an entry the snapshot does not show", async () => {
  // 応答を止めると本文の無い assistant が葉になる。表示は止めた発言で終わるが戻せる。
  const stopped = messages.slice(0, 3);
  const { app, sent } = createEditApp({ messages: stopped, leafId: "a-aborted" });
  const response = await post(app, { messageId: "u2", requestId: "req-1", text: "edited" });

  expect(response.status).toBe(200);
  expect(sent).toEqual(["/hwc-rewind u2 req-1", "edited"]);
});

test("rejects the leaf, an attachment, a missing capability, and a busy pane", async () => {
  const last = createEditApp({ messages: messages.slice(0, 3) });
  const lastResponse = await post(last.app, { messageId: "u2", requestId: "r1", text: "x" });
  expect(lastResponse.status).toBe(409);

  const attachment = createEditApp({
    messages: messages.map((message) =>
      message.id === "u2" ? { ...message, attachments: [{ name: "photo.png", size: 3 }] } : message,
    ),
  });
  expect(
    (await post(attachment.app, { messageId: "u2", requestId: "r-attachment", text: "x" })).status,
  ).toBe(409);

  const noCapability = createEditApp({ canRewind: false });
  expect(
    (await post(noCapability.app, { messageId: "u2", requestId: "r2", text: "x" })).status,
  ).toBe(409);

  const busy = createEditApp({ state: panesState({ agentStatus: "working" }) });
  expect((await post(busy.app, { messageId: "u2", requestId: "r3", text: "x" })).status).toBe(409);
});

test("rejects a pane that is not pi and a request with a message id from another shape", async () => {
  const codex = createEditApp({ state: panesState({ agent: "codex" }) });
  expect((await post(codex.app, { messageId: "u2", requestId: "r1", text: "x" })).status).toBe(404);

  const { app } = createEditApp();
  expect((await post(app, { messageId: "u2", requestId: "not allowed", text: "x" })).status).toBe(
    400,
  );
  expect((await post(app, { messageId: "u2", requestId: "r1", text: " " })).status).toBe(400);
});

test("a second edit while the first is in flight is rejected", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, sent } = createEditApp({
    onSend: async (text) => {
      if (text.startsWith("/hwc-rewind ")) await gate;
    },
  });
  const first = post(app, { messageId: "u2", requestId: "r1", text: "edited" });
  await waitFor(() => sent.length === 1);
  const second = await post(app, { messageId: "u2", requestId: "r2", text: "other" });
  expect(second.status).toBe(409);
  release();
  expect((await first).status).toBe(200);
});

test("a marker for another target is not accepted", async () => {
  const { app } = createEditApp({ markerTarget: "u1" });
  const response = await post(app, { messageId: "u2", requestId: "req-1", text: "edited" });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "edit_failed" });
});
