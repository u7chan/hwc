import { expect, test } from "bun:test";
import {
  MAX_ACTIVE_ORDER,
  createActiveOrderStore,
  parseActiveOrder,
  parseActiveOrderBody,
} from "./active-order";
import type { StateFile } from "./state-file";

function memoryFile(initial: string | null = null): StateFile & { raw: string | null } {
  const file = {
    raw: initial,
    read: () => file.raw,
    write: (raw: string) => {
      file.raw = raw;
    },
  };
  return file;
}

test("an order is read back as the ids it holds, in order", () => {
  expect(parseActiveOrder(["w2", "w1"])).toEqual(["w2", "w1"]);
  // 壊れた値・空の id・重複は捨てる。並びが読めないだけで一覧を止めない。
  expect(parseActiveOrder(["w2", "", 3, null, "w2", "w1"])).toEqual(["w2", "w1"]);
  expect(parseActiveOrder("w2")).toEqual([]);
  expect(parseActiveOrder(null)).toEqual([]);
});

test("an order longer than the limit is cut", () => {
  const ids = Array.from({ length: MAX_ACTIVE_ORDER + 20 }, (_, at) => `w${at}`);

  expect(parseActiveOrder(ids)).toHaveLength(MAX_ACTIVE_ORDER);
});

test("the saved order comes back after a restart", () => {
  const file = memoryFile();
  const store = createActiveOrderStore(file);
  expect(store.get()).toEqual([]);

  store.save(["w3", "w1", "w2"]);

  expect(JSON.parse(file.raw ?? "null")).toEqual(["w3", "w1", "w2"]);
  expect(createActiveOrderStore(file).get()).toEqual(["w3", "w1", "w2"]);
});

test("a broken file falls back to the Herdr order", () => {
  expect(createActiveOrderStore(memoryFile("{")).get()).toEqual([]);
  expect(createActiveOrderStore(memoryFile('{"w1":1}')).get()).toEqual([]);
});

test("the body must carry the full order as unique ids", () => {
  expect(parseActiveOrderBody({ workspaceIds: ["w2", "w1"] })).toEqual({
    ok: true,
    value: ["w2", "w1"],
  });

  expect(parseActiveOrderBody(null).ok).toBe(false);
  expect(parseActiveOrderBody([]).ok).toBe(false);
  expect(parseActiveOrderBody({}).ok).toBe(false);
  expect(parseActiveOrderBody({ workspaceIds: [] }).ok).toBe(false);
  expect(parseActiveOrderBody({ workspaceIds: ["w1", "w1"] }).ok).toBe(false);
  expect(parseActiveOrderBody({ workspaceIds: ["w1", ""] }).ok).toBe(false);
  expect(parseActiveOrderBody({ workspaceIds: ["w1", 2] }).ok).toBe(false);
  expect(
    parseActiveOrderBody({
      workspaceIds: Array.from({ length: MAX_ACTIVE_ORDER + 1 }, (_, at) => `w${at}`),
    }).ok,
  ).toBe(false);
});
