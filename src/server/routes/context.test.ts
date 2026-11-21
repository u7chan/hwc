import { expect, test } from "bun:test";
import type { Context } from "hono";
import {
  createFakeChat,
  createFakePanes,
  createFakeStore,
  createFakeWorktrees,
  createFakeWorkspaces,
  type FakeStore,
  pane,
  state,
} from "../app.test-helpers";
import { createAppContext } from "./context";

// ハンドラと同じ形にする。ヘルパはパスの id と、失敗応答の組み立てだけを使う。
const contextFor = (paneId: string) =>
  ({
    req: { param: () => paneId },
    json: (body: unknown, status: number) => Response.json(body, { status }),
  }) as unknown as Context;

const createContext = (store: FakeStore) =>
  createAppContext({
    store,
    panes: createFakePanes(),
    worktrees: createFakeWorktrees(),
    workspaces: createFakeWorkspaces(),
    chat: createFakeChat(),
  });

test("resolvePane returns the state and the pane for a known id", async () => {
  const store = createFakeStore(state);
  const resolved = await createContext(store).resolvePane(contextFor(pane.id));

  expect(resolved).toEqual({ ok: true, state, paneId: pane.id, pane });
  // 状態が揃っていれば Herdr を読み直さない。
  expect(store.refreshCount()).toBe(0);
});

test("resolvePane only requires the pane to exist, not to hold a chat", async () => {
  // 会話やエージェント種別の判定はルートごとに違う。ヘルパには入れない。
  const resolved = await createContext(createFakeStore(state)).resolvePane(contextFor("w1:p1"));

  expect(resolved.ok).toBe(true);
});

test("resolvePane answers 404 pane_not_found for an unknown id", async () => {
  const store = createFakeStore(state);
  const resolved = await createContext(store).resolvePane(contextFor("w1:missing"));

  expect(resolved.ok).toBe(false);
  if (resolved.ok) return;
  expect(resolved.response.status).toBe(404);
  expect(await resolved.response.json()).toEqual({ error: "pane_not_found" });
  expect(store.refreshCount()).toBe(0);
});

test("resolvePane answers 502 herdr_unavailable when the state cannot be read", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  const resolved = await createContext(store).resolvePane(contextFor(pane.id));

  expect(resolved.ok).toBe(false);
  if (resolved.ok) return;
  expect(resolved.response.status).toBe(502);
  expect(await resolved.response.json()).toEqual({ error: "herdr_unavailable" });
  // 読み直しは 1 回だけ。ペインの判定まで進まない。
  expect(store.refreshCount()).toBe(1);
});

test("resolvePane uses the state it read when the store was still empty", async () => {
  const store = createFakeStore(null);
  const resolved = await createContext(store).resolvePane(contextFor(pane.id));

  expect(resolved).toEqual({ ok: true, state, paneId: pane.id, pane });
  expect(store.refreshCount()).toBe(1);
});

test("resolveState answers the same failure without looking up a pane", async () => {
  const ok = await createContext(createFakeStore(state)).resolveState(contextFor(pane.id));
  expect(ok).toEqual({ ok: true, state });

  const failed = await createContext(
    createFakeStore(null, new Error("socket closed")),
  ).resolveState(contextFor(pane.id));
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.response.status).toBe(502);
  expect(await failed.response.json()).toEqual({ error: "herdr_unavailable" });
});
