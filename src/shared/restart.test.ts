import { expect, test } from "bun:test";
import { DEFAULT_RESTART_SETTINGS, normalizeRestartCommand, parseRestartSettings } from "./restart";

test("keeps an absolute path as the command", () => {
  expect(normalizeRestartCommand("/usr/local/bin/restart-hwc")).toBe("/usr/local/bin/restart-hwc");
  // 空白を含むパスは実行できるので受ける。前後の空白だけ落とす。
  expect(normalizeRestartCommand("  /opt/hwc/restart me  ")).toBe("/opt/hwc/restart me");
});

test("treats an empty value as unset", () => {
  expect(normalizeRestartCommand(null)).toBeNull();
  expect(normalizeRestartCommand("")).toBeNull();
  expect(normalizeRestartCommand("   ")).toBeNull();
});

test("refuses values that are not an absolute path", () => {
  expect(normalizeRestartCommand("restart-hwc")).toBeUndefined();
  expect(normalizeRestartCommand("./restart-hwc")).toBeUndefined();
  expect(normalizeRestartCommand("~/bin/restart-hwc")).toBeUndefined();
  expect(normalizeRestartCommand(42)).toBeUndefined();
});

test("refuses values that break a log line or overflow the field", () => {
  expect(normalizeRestartCommand("/opt/restart\nhwc")).toBeUndefined();
  expect(normalizeRestartCommand("/opt/restart\t-hwc")).toBeUndefined();
  expect(normalizeRestartCommand(`/${"a".repeat(512)}`)).toBeUndefined();
});

test("falls back to the defaults for a missing or broken file", () => {
  expect(parseRestartSettings(null)).toEqual(DEFAULT_RESTART_SETTINGS);
  expect(parseRestartSettings({ afterPull: "yes" })).toEqual(DEFAULT_RESTART_SETTINGS);
  expect(parseRestartSettings({ command: "relative/path", afterPull: true })).toEqual({
    command: null,
    afterPull: true,
  });
  expect(parseRestartSettings({ command: "/usr/local/bin/restart-hwc", afterPull: true })).toEqual({
    command: "/usr/local/bin/restart-hwc",
    afterPull: true,
  });
});
