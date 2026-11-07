import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityPath, readActivity } from "./activity";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hwc-activity-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const now = 1_800_000_000_000;

test("reads the sidecar next to the session file", async () => {
  const session = join(root, "2026-01-01T09-00-00-000Z_abc.jsonl");
  await writeFile(
    activityPath(session),
    JSON.stringify({ v: 1, at: now, phase: "thinking", text: "手順を考えています" }),
  );

  expect(activityPath(session)).toBe(`${session}.thinking.json`);
  expect(await readActivity(session, now)).toEqual({
    phase: "thinking",
    text: "手順を考えています",
    tool: null,
    tools: 1,
    at: now,
  });
});

test("a pane without the extension is not an error", async () => {
  const session = join(root, "session.jsonl");
  await writeFile(session, "\n");
  expect(await readActivity(session, now)).toBeNull();
});

test("ignores broken, oversized and stale files", async () => {
  const session = join(root, "session.jsonl");
  const path = activityPath(session);

  await writeFile(path, "not json");
  expect(await readActivity(session, now)).toBeNull();

  await writeFile(
    path,
    JSON.stringify({ v: 1, at: now, phase: "thinking", text: "x".repeat(9_000) }),
  );
  expect(await readActivity(session, now)).toBeNull();

  await writeFile(path, JSON.stringify({ v: 1, at: now - 31 * 60 * 1_000, phase: "thinking" }));
  expect(await readActivity(session, now)).toBeNull();
});
