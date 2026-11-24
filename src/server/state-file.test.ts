import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createJsonStore, createStateFile } from "./state-file";

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hwc-state-file-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("read returns the text of the file as it is", () => {
  const root = createRoot();
  const path = join(root, "settings.json");
  writeFileSync(path, '{"enabled":true}');

  expect(createStateFile(path).read()).toBe('{"enabled":true}');
});

test("read answers null when the file cannot be read", () => {
  const root = createRoot();
  mkdirSync(join(root, "settings.json"));

  expect(createStateFile(join(root, "missing.json")).read()).toBeNull();
  // ディレクトリや権限の無いファイルも、読めないものは同じ null。
  expect(createStateFile(join(root, "settings.json")).read()).toBeNull();
});

test("write creates the directory and leaves no temporary file", () => {
  const root = createRoot();
  const path = join(root, "nested", "state", "settings.json");
  const file = createStateFile(path);

  file.write("first");
  file.write("second");

  expect(readFileSync(path, "utf8")).toBe("second");
  expect(readdirSync(join(root, "nested", "state"))).toEqual(["settings.json"]);
});

test("a stale fixed-name temporary file does not get in the way", () => {
  const root = createRoot();
  const path = join(root, "settings.json");
  writeFileSync(`${path}.tmp`, "stale");

  createStateFile(path).write("{}");

  expect(readFileSync(`${path}.tmp`, "utf8")).toBe("stale");
  expect(readFileSync(path, "utf8")).toBe("{}");
});

test("a temporary file left by a crash blocks the write that reuses its name", () => {
  const root = createRoot();
  const path = join(root, "settings.json");
  const file = createStateFile(path);
  writeFileSync(`${path}.${process.pid}.1.tmp`, "stale");

  // 一意な名前は wx で作るので、残骸を上書きしない。書き込みは失敗し、残骸は片付く。
  expect(() => file.write("first")).toThrow();
  file.write("second");

  expect(readFileSync(path, "utf8")).toBe("second");
  expect(readdirSync(root)).toEqual(["settings.json"]);
});

test("a failed write removes the temporary file and rethrows the original error", () => {
  const root = createRoot();
  const path = join(root, "settings.json");
  // rename の置き換え先をディレクトリにして失敗させる。中身のあるディレクトリへは rename できない。
  mkdirSync(path);
  writeFileSync(join(path, "keep"), "");

  expect(() => createStateFile(path).write("{}")).toThrow();
  expect(readdirSync(root)).toEqual(["settings.json"]);
});

test("the mode is applied even when umask would drop it", () => {
  const root = createRoot();
  const path = join(root, "settings.json");
  const file = createStateFile(path, { mode: 0o600 });

  // umask は指定した mode から bit を落とすので、chmod が無ければ 0o000 で残る。
  const previous = process.umask(0o777);
  try {
    file.write("{}");
  } finally {
    process.umask(previous);
  }

  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).toBe("{}");
});

test("the store starts from the fallback when the file is missing or broken", () => {
  const root = createRoot();
  const path = join(root, "settings.json");
  const fallback = { enabled: false };

  expect(createJsonStore(createStateFile(path), fallback, () => ({ enabled: true })).get()).toEqual(
    fallback,
  );

  writeFileSync(path, "{not json");
  expect(createJsonStore(createStateFile(path), fallback, () => ({ enabled: true })).get()).toEqual(
    fallback,
  );
});

test("the store keeps the fallback when the parsed value is rejected", () => {
  const root = createRoot();
  const path = join(root, "settings.json");
  writeFileSync(path, '{"enabled":"yes"}');

  const store = createJsonStore(createStateFile(path), false, (value) => {
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    return (value as { enabled?: unknown }).enabled === true;
  });

  expect(store.get()).toBe(false);
});

test("the store replaces the value in memory only after the write succeeds", () => {
  let fail = false;
  const store = createJsonStore(
    {
      read: () => null,
      write: () => {
        if (fail) throw new Error("disk full");
      },
    },
    0,
    (value) => (typeof value === "number" ? value : 0),
  );

  store.save(1);
  fail = true;
  expect(() => store.save(2)).toThrow();
  expect(store.get()).toBe(1);
});
