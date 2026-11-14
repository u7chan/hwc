import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { Template } from "../shared/templates";
import { createTemplatesFile, createTemplatesStore, templatesPath } from "./templates";

const sample: Template[] = [
  { id: "t1", title: "続けて", body: "続けてください。" },
  { id: "t2", title: "コミットして", body: "コミットしてください。" },
];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hwc-templates-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a missing file starts with no templates", () => {
  const store = createTemplatesStore(createTemplatesFile(createRoot()));
  expect(store.get()).toEqual([]);
});

test("saved templates survive in the state directory", () => {
  const root = createRoot();
  createTemplatesStore(createTemplatesFile(root)).save(sample);

  expect(createTemplatesStore(createTemplatesFile(root)).get()).toEqual(sample);
  expect(JSON.parse(readFileSync(templatesPath(root), "utf8"))).toEqual(sample);
});

test("a broken file falls back to an empty list", () => {
  const root = createRoot();
  writeFileSync(templatesPath(root), "{not json");
  expect(createTemplatesStore(createTemplatesFile(root)).get()).toEqual([]);

  // 手で書き換えられたファイルでも、壊れた行だけを捨てて読む。
  writeFileSync(templatesPath(root), JSON.stringify([sample[0], { id: "bad id" }, null]));
  expect(createTemplatesStore(createTemplatesFile(root)).get()).toEqual([sample[0]]);
});

test("a failed write leaves the previous list in memory", () => {
  let fail = false;
  const store = createTemplatesStore({
    read: () => null,
    write: () => {
      if (fail) throw new Error("disk full");
    },
  });
  store.save(sample);

  fail = true;
  expect(() => store.save([])).toThrow();
  expect(store.get()).toEqual(sample);
});

test("the state directory is created on the first save", () => {
  const root = join(createRoot(), "nested", "state");
  const store = createTemplatesStore(createTemplatesFile(root));
  store.save(sample);
  expect(store.get()).toEqual(sample);
});
