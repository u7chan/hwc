import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { LaunchDefault } from "../shared/launch-defaults";
import {
  createLaunchDefaultsFile,
  createLaunchDefaultsStore,
  launchDefaultsPath,
} from "./launch-defaults";

const sonnet: LaunchDefault = { model: { provider: "claude", id: "sonnet" }, effort: "high" };
const beam: LaunchDefault = {
  model: { provider: "example", id: "@demo/beam-small" },
  effort: null,
};

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hwc-launch-defaults-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a missing file starts with no defaults", () => {
  const store = createLaunchDefaultsStore(createLaunchDefaultsFile(createRoot()));
  expect(store.get()).toEqual({});
});

test("saved defaults survive a restart of the BFF", () => {
  const root = createRoot();
  const store = createLaunchDefaultsStore(createLaunchDefaultsFile(root));
  store.set("claude", sonnet);
  store.set("pi", beam);

  expect(createLaunchDefaultsStore(createLaunchDefaultsFile(root)).get()).toEqual({
    claude: sonnet,
    pi: beam,
  });
  expect(JSON.parse(readFileSync(launchDefaultsPath(root), "utf8"))).toEqual({
    claude: sonnet,
    pi: beam,
  });
  // 書き込みは一意な tmp を rename で置き換えるので、残骸を残さない。
  expect(readdirSync(root)).toEqual(["launch-defaults.json"]);
});

test("clearing a default removes only that agent", () => {
  const store = createLaunchDefaultsStore(createLaunchDefaultsFile(createRoot()));
  store.set("claude", sonnet);
  store.set("pi", beam);

  store.set("claude", null);

  expect(store.get()).toEqual({ pi: beam });
});

test("a broken file falls back to no defaults", () => {
  const root = createRoot();
  writeFileSync(launchDefaultsPath(root), "{not json");
  expect(createLaunchDefaultsStore(createLaunchDefaultsFile(root)).get()).toEqual({});
});

test("unknown agents and broken values are dropped one by one", () => {
  const root = createRoot();
  writeFileSync(
    launchDefaultsPath(root),
    JSON.stringify({
      claude: sonnet,
      shell: sonnet,
      pi: { model: { provider: "example", id: "--help" }, effort: null },
      codex: { model: { provider: "example", id: "beam" }, effort: "" },
      opencode: { model: { provider: "example", id: "beam" } },
    }),
  );

  expect(createLaunchDefaultsStore(createLaunchDefaultsFile(root)).get()).toEqual({
    claude: sonnet,
  });
});

test("a failed write leaves the previous defaults in memory", () => {
  let fail = false;
  const store = createLaunchDefaultsStore({
    read: () => null,
    write: () => {
      if (fail) throw new Error("disk full");
    },
  });
  store.set("claude", sonnet);

  fail = true;
  expect(() => store.set("claude", null)).toThrow();
  expect(() => store.set("pi", beam)).toThrow();
  expect(store.get()).toEqual({ claude: sonnet });
});

test("the state directory is created on the first save", () => {
  const root = join(createRoot(), "nested", "state");
  createLaunchDefaultsStore(createLaunchDefaultsFile(root)).set("claude", sonnet);
  expect(createLaunchDefaultsStore(createLaunchDefaultsFile(root)).get()).toEqual({
    claude: sonnet,
  });
});
