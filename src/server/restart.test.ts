import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { DEFAULT_RESTART_SETTINGS } from "../shared/restart";
import {
  createRestartRunner,
  createRestartSettingsFile,
  createRestartSettingsStore,
  restartSettingsPath,
} from "./restart";

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hwc-restart-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the settings file starts from the defaults when it does not exist", () => {
  const root = createRoot();
  const store = createRestartSettingsStore(createRestartSettingsFile(root));
  expect(store.get()).toEqual(DEFAULT_RESTART_SETTINGS);
});

test("saved settings survive in the state directory", () => {
  const root = createRoot();
  const first = createRestartSettingsStore(createRestartSettingsFile(root));
  first.save({ command: "/opt/hwc/restart", afterPull: true });

  const second = createRestartSettingsStore(createRestartSettingsFile(root));
  expect(second.get()).toEqual({ command: "/opt/hwc/restart", afterPull: true });
  expect(JSON.parse(readFileSync(restartSettingsPath(root), "utf8"))).toEqual({
    command: "/opt/hwc/restart",
    afterPull: true,
  });
});

test("a broken or unreadable file falls back to the defaults", () => {
  const root = createRoot();
  writeFileSync(restartSettingsPath(root), "{not json");
  expect(createRestartSettingsStore(createRestartSettingsFile(root)).get()).toEqual(
    DEFAULT_RESTART_SETTINGS,
  );

  // 相対パスは設定ファイルを手で書き換えられても実行対象にしない。
  writeFileSync(restartSettingsPath(root), JSON.stringify({ command: "restart", afterPull: true }));
  expect(createRestartSettingsStore(createRestartSettingsFile(root)).get()).toEqual({
    command: null,
    afterPull: true,
  });
});

test("a failed write leaves the previous settings in memory", () => {
  const root = createRoot();
  const store = createRestartSettingsStore(createRestartSettingsFile(root));
  store.save({ command: "/opt/hwc/restart", afterPull: false });

  // 状態ディレクトリの代わりに通常ファイルを置き、書き込みを失敗させる。
  const file = createRestartSettingsFile(join(root, "file"));
  writeFileSync(join(root, "file"), "");
  expect(() => file.write("{}")).toThrow();
  expect(store.get()).toEqual({ command: "/opt/hwc/restart", afterPull: false });
});

test("a command that is not an executable file is refused before spawning", () => {
  const root = createRoot();
  const script = join(root, "restart.sh");
  writeFileSync(script, "#!/bin/sh\n");

  const spawned: Array<{ command: string; cwd: string }> = [];
  const runner = createRestartRunner({
    spawn: (command, cwd) => {
      spawned.push({ command, cwd });
      return { exited: Promise.resolve(0) };
    },
  });

  expect(runner.isExecutable(script)).toBe(false);
  expect(runner.run(script, root)).toBe("not_executable");
  expect(runner.isExecutable(join(root, "missing"))).toBe(false);
  expect(runner.isExecutable(root)).toBe(false);
  expect(spawned).toEqual([]);

  chmodSync(script, 0o755);
  expect(runner.isExecutable(script)).toBe(true);
  expect(runner.run(script, root)).toBe("started");
  // コマンドは pull したチェックアウトで動く。どのリポジトリを再起動してよいかは
  // コマンドが cwd で判定する。
  expect(spawned).toEqual([{ command: script, cwd: root }]);
});

test("the settings directory is created on the first save", () => {
  const root = join(createRoot(), "nested", "state");
  const store = createRestartSettingsStore(createRestartSettingsFile(root));
  store.save({ command: null, afterPull: true });
  expect(store.get()).toEqual({ command: null, afterPull: true });
});

test("a command that exits with a failure is logged", async () => {
  const root = createRoot();
  const script = join(root, "restart.sh");
  writeFileSync(script, "#!/bin/sh\nexit 3\n");
  chmodSync(script, 0o755);

  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => errors.push(message);
  try {
    const runner = createRestartRunner({
      spawn: () => ({ exited: Promise.resolve(3) }),
    });
    expect(runner.run(script, root)).toBe("started");
    await Bun.sleep(0);
  } finally {
    console.error = original;
  }
  expect(errors).toEqual([`restart: ${script} exited with 3`]);
});

test("a settings file that cannot be written surfaces the failure", () => {
  const root = createRoot();
  mkdirSync(join(root, "state"), { recursive: true });
  // root を読み取り専用にして、一時ファイルの作成を失敗させる。
  chmodSync(join(root, "state"), 0o500);
  try {
    const store = createRestartSettingsStore(
      createRestartSettingsFile(join(root, "state", "nested")),
    );
    expect(() => store.save({ command: null, afterPull: false })).toThrow();
    expect(store.get()).toEqual(DEFAULT_RESTART_SETTINGS);
  } finally {
    chmodSync(join(root, "state"), 0o700);
  }
});
