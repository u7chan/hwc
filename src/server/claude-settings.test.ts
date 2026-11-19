import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettingsJson, ensureClaudeSettings } from "./claude-settings";

test("every hook calls the same command with the sidecar root as its argument", () => {
  const settings = JSON.parse(
    claudeSettingsJson({
      runtime: "/opt/bun/bin/bun",
      script: "/srv/hwc/src/server/claude-hook.ts",
      root: "/var/state/hwc/claude/pending",
      live: "/var/state/hwc/claude/live",
    }),
  );

  expect(Object.keys(settings.hooks).sort()).toEqual(
    [
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "SessionEnd",
      "Stop",
      "UserPromptSubmit",
    ].sort(),
  );
  const commands = new Set(
    Object.values<{ hooks: { type: string; command: string }[] }[]>(settings.hooks).flatMap(
      (entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    ),
  );
  expect([...commands]).toEqual([
    "'/opt/bun/bin/bun' '/srv/hwc/src/server/claude-hook.ts' '/var/state/hwc/claude/pending'",
  ]);
  expect(settings.env).toEqual({ HWC_CLAUDE_LIVE_DIR: "/var/state/hwc/claude/live" });
});

test("paths with spaces and quotes stay one word each", () => {
  const settings = JSON.parse(
    claudeSettingsJson({
      runtime: "/opt/my bun/bun",
      script: "/srv/it's/claude-hook.ts",
      root: "/var/state/pending",
      live: "/var/state/live",
    }),
  );

  expect(settings.hooks.Stop[0].hooks[0].command).toBe(
    `'/opt/my bun/bun' '/srv/it'\\''s/claude-hook.ts' '/var/state/pending'`,
  );
});

test("the settings file is written under the state directory and left alone when unchanged", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hwc-claude-settings-"));
  try {
    const launch = await ensureClaudeSettings(stateRoot);

    expect(launch.settings).toBe(join(stateRoot, "claude", "settings.json"));
    expect(launch.pluginDir?.endsWith("/claude-mod")).toBe(true);
    const settings = JSON.parse(await readFile(launch.settings, "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
      join(stateRoot, "claude", "pending"),
    );
    expect(settings.env.HWC_CLAUDE_LIVE_DIR).toBe(join(stateRoot, "claude", "live"));
    expect((await stat(join(stateRoot, "claude", "live"))).mode & 0o777).toBe(0o700);

    const past = new Date(Date.now() - 60_000);
    await utimes(launch.settings, past, past);
    await ensureClaudeSettings(stateRoot);
    expect((await stat(launch.settings)).mtimeMs).toBe(past.getTime());
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("the settings file is private to the owner, including one created with looser permissions", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hwc-claude-settings-"));
  try {
    const { settings: path } = await ensureClaudeSettings(stateRoot);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // 内容が同じなら書き直されないが、モードだけは直る。
    await chmod(path, 0o644);
    await ensureClaudeSettings(stateRoot);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
