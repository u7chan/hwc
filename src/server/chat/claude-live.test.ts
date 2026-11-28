import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSince, LIVE_TTL_MS, livePath, parseLive, readLive } from "./claude-live";

const SESSION = "6b1d7a44-2f3c-4e5b-8a19-7c2d3e4f5a6b";
const NOW = 1_800_000_000_000;

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    sessionId: SESSION,
    at: NOW,
    tokPerSecond: 68.4,
    ...overrides,
  });
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hwc-claude-live-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a fresh file gives the rate", async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${SESSION}.json`), body());
    expect(await readLive(root, SESSION, NOW)).toEqual({
      tokPerSecond: 68.4,
      context: null,
      contextAt: null,
      at: NOW,
    });
  });
});

test("there is no rate before the mod writes one", async () => {
  await withRoot(async (root) => {
    expect(await readLive(root, SESSION, NOW)).toBeNull();
  });
});

test("an old file is a leftover, not a rate", () => {
  expect(parseLive(JSON.parse(body({ at: NOW - LIVE_TTL_MS - 1 })), SESSION, NOW)).toBeNull();
});

test("another session's file is not used", () => {
  expect(parseLive(JSON.parse(body()), "other-session", NOW)).toBeNull();
});

test("a cleared rate keeps the file valid without a number", () => {
  expect(parseLive(JSON.parse(body({ tokPerSecond: null })), SESSION, NOW)).toEqual({
    tokPerSecond: null,
    context: null,
    contextAt: null,
    at: NOW,
  });
});

test("a broken rate is not shown", () => {
  for (const rate of [0, -1, "fast"]) {
    expect(parseLive(JSON.parse(body({ tokPerSecond: rate })), SESSION, NOW)).toBeNull();
  }
  const missing = JSON.parse(body()) as Record<string, unknown>;
  delete missing.tokPerSecond;
  expect(parseLive(missing, SESSION, NOW)).toBeNull();
});

test("a rate above the activity limit is clamped", () => {
  expect(parseLive(JSON.parse(body({ tokPerSecond: 99_999 })), SESSION, NOW)).toEqual({
    tokPerSecond: 10_000,
    context: null,
    contextAt: null,
    at: NOW,
  });
});

test("a partly written file and an oversized file are ignored", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, `${SESSION}.json`), body().slice(0, 20));
    expect(await readLive(root, SESSION, NOW)).toBeNull();

    await writeFile(join(root, `${SESSION}.json`), "x".repeat(5 * 1024));
    expect(await readLive(root, SESSION, NOW)).toBeNull();
  });
});

test("a session id that could leave the directory has no path", () => {
  expect(livePath("/state/live", "../escape")).toBeNull();
  expect(livePath("/state/live", SESSION)).toBe(join("/state/live", `${SESSION}.json`));
});

const context = { tokens: 122_600, window: 1_000_000 };

test("the context is read with the rate and the time it was read", () => {
  expect(parseLive(JSON.parse(body({ context, contextAt: NOW - 1_000 })), SESSION, NOW)).toEqual({
    tokPerSecond: 68.4,
    context,
    contextAt: NOW - 1_000,
    at: NOW,
  });
  // /context と同じで、まだ要求が無いセッションは window だけになる。
  expect(
    parseLive(JSON.parse(body({ context: { window: 200_000 }, contextAt: NOW })), SESSION, NOW),
  ).toEqual({
    tokPerSecond: 68.4,
    context: { tokens: null, window: 200_000 },
    contextAt: NOW,
    at: NOW,
  });
  // 読んだ時刻を書かない版のファイルは、いつ読んだか分からないので null にする。
  expect(parseLive(JSON.parse(body({ context })), SESSION, NOW)).toEqual({
    tokPerSecond: 68.4,
    context,
    contextAt: null,
    at: NOW,
  });
});

test("an old file keeps its context but loses the rate", () => {
  const stale = JSON.parse(body({ at: NOW - LIVE_TTL_MS - 1, context, contextAt: NOW - 5_000 }));
  expect(parseLive(stale, SESSION, NOW)).toEqual({
    tokPerSecond: null,
    context,
    contextAt: NOW - 5_000,
    at: stale.at,
  });
});

test("an old file without context is still a leftover", () => {
  expect(parseLive(JSON.parse(body({ at: NOW - LIVE_TTL_MS - 1 })), SESSION, NOW)).toBeNull();
});

test("a broken context is no context, but a broken rate still voids the file", () => {
  for (const broken of [{ tokens: -1 }, { tokens: "many", window: 0 }, [], null]) {
    expect(parseLive(JSON.parse(body({ context: broken, contextAt: NOW })), SESSION, NOW)).toEqual({
      tokPerSecond: 68.4,
      context: null,
      contextAt: null,
      at: NOW,
    });
  }
  expect(parseLive(JSON.parse(body({ tokPerSecond: "fast", context })), SESSION, NOW)).toBeNull();
});

// 圧縮で文脈は切り詰められる。圧縮より前に読んだ値は、今の量ではない。
test("a context read before the compaction is not shown", () => {
  const live = { tokPerSecond: null, context, contextAt: NOW, at: NOW };

  expect(contextSince(live, NOW)).toBeNull();
  expect(contextSince(live, NOW - 1)).toEqual(context);
  expect(contextSince(live, null)).toEqual(context);
  expect(contextSince(null, NOW)).toBeNull();
  expect(
    contextSince({ tokPerSecond: 1, context: null, contextAt: null, at: NOW }, null),
  ).toBeNull();
});

// 書いた時刻 at はターン中にも進む。読んだ時刻が分からない値は、圧縮後も出さない。
test("a context without the time it was read is not shown after a compaction", () => {
  const live = { tokPerSecond: 68.4, context, contextAt: null, at: NOW + 60_000 };

  expect(contextSince(live, NOW)).toBeNull();
  expect(contextSince(live, null)).toEqual(context);
});
