import { expect, test } from "bun:test";
import {
  agentOfCategory,
  SETTINGS_CATEGORIES,
  settingsCategoryLabel,
  settingsCategoryValue,
} from "./categories";

const loaded = {
  theme: "system" as const,
  split: true,
  connection: "live" as const,
  revision: "abc1234",
  templates: 3,
  notifications: true,
  restart: true,
  launchDefaults: {
    claude: { model: { provider: "claude", id: "sonnet" }, effort: "high" },
    opencode: { model: { provider: "example", id: "@demo/beam-small" }, effort: null },
  },
};

test("each row shows the current value without opening the screen", () => {
  expect(settingsCategoryValue("display", loaded)).toBe("システム");
  expect(settingsCategoryValue("display", { ...loaded, theme: "nord" })).toBe("Nord");
  expect(settingsCategoryValue("split", loaded)).toBe("オン");
  expect(settingsCategoryValue("split", { ...loaded, split: false })).toBe("オフ");
  expect(settingsCategoryValue("templates", loaded)).toBe("3 件");
  expect(settingsCategoryValue("notifications", loaded)).toBe("オン");
  expect(settingsCategoryValue("notifications", { ...loaded, notifications: false })).toBe("オフ");
  expect(settingsCategoryValue("restart", loaded)).toBe("設定済み");
  expect(settingsCategoryValue("restart", { ...loaded, restart: false })).toBe("未設定");
  expect(settingsCategoryValue("connection", loaded)).toBe("接続済み");
  expect(settingsCategoryValue("connection", { ...loaded, connection: "unavailable" })).toBe(
    "Herdr 未接続",
  );
  expect(settingsCategoryValue("build", loaded)).toBe("abc1234");
});

test("each agent row shows its default model and effort for new panes", () => {
  expect(settingsCategoryValue("agent-claude", loaded)).toBe("claude/sonnet / high");
  // effort に対応しないモデルは、モデルだけを出す。
  expect(settingsCategoryValue("agent-opencode", loaded)).toBe("example/@demo/beam-small");
  expect(settingsCategoryValue("agent-pi", loaded)).toBe("未設定");
});

test("a value that has not loaded stays empty instead of guessing", () => {
  expect(settingsCategoryValue("split", { ...loaded, split: null })).toBeNull();
  expect(settingsCategoryValue("templates", { ...loaded, templates: null })).toBeNull();
  expect(settingsCategoryValue("notifications", { ...loaded, notifications: null })).toBeNull();
  expect(settingsCategoryValue("restart", { ...loaded, restart: null })).toBeNull();
  expect(settingsCategoryValue("build", { ...loaded, revision: null })).toBeNull();
  expect(settingsCategoryValue("agent-pi", { ...loaded, launchDefaults: null })).toBeNull();
});

test("rows are split into the settings you change, the agents, and the app state you read", () => {
  expect(SETTINGS_CATEGORIES.map((category) => category.id)).toEqual([
    "display",
    "split",
    "templates",
    "notifications",
    "restart",
    "agent-pi",
    "agent-claude",
    "agent-codex",
    "agent-opencode",
    "connection",
    "build",
  ]);
  expect(SETTINGS_CATEGORIES.filter((category) => category.group === "settings")).toHaveLength(5);
  expect(SETTINGS_CATEGORIES.filter((category) => category.group === "agents")).toHaveLength(4);
  expect(SETTINGS_CATEGORIES.filter((category) => category.group === "app")).toHaveLength(2);
});

test("an agent row opens that agent's screen", () => {
  expect(agentOfCategory("agent-claude")).toBe("claude");
  expect(agentOfCategory("templates")).toBeNull();
});

test("the screen title uses the row label", () => {
  expect(settingsCategoryLabel("split")).toBe("ペイン分割");
  expect(settingsCategoryLabel("templates")).toBe("定型文");
  expect(settingsCategoryLabel("build")).toBe("バージョン");
  expect(settingsCategoryLabel("agent-opencode")).toBe("OpenCode");
});
