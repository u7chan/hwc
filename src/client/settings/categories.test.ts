import { expect, test } from "bun:test";
import { SETTINGS_CATEGORIES, settingsCategoryLabel, settingsCategoryValue } from "./categories";

const loaded = {
  theme: "system" as const,
  connection: "live" as const,
  revision: "abc1234",
  templates: 3,
  notifications: true,
  restart: true,
};

test("each row shows the current value without opening the screen", () => {
  expect(settingsCategoryValue("display", loaded)).toBe("システム");
  expect(settingsCategoryValue("display", { ...loaded, theme: "nord" })).toBe("Nord");
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

test("a value that has not loaded stays empty instead of guessing", () => {
  expect(settingsCategoryValue("templates", { ...loaded, templates: null })).toBeNull();
  expect(settingsCategoryValue("notifications", { ...loaded, notifications: null })).toBeNull();
  expect(settingsCategoryValue("restart", { ...loaded, restart: null })).toBeNull();
  expect(settingsCategoryValue("build", { ...loaded, revision: null })).toBeNull();
});

test("rows are split into the settings you change and the app state you read", () => {
  expect(SETTINGS_CATEGORIES.map((category) => category.id)).toEqual([
    "display",
    "templates",
    "notifications",
    "restart",
    "connection",
    "build",
  ]);
  expect(SETTINGS_CATEGORIES.filter((category) => category.group === "settings")).toHaveLength(4);
  expect(SETTINGS_CATEGORIES.filter((category) => category.group === "app")).toHaveLength(2);
});

test("the screen title uses the row label", () => {
  expect(settingsCategoryLabel("templates")).toBe("定型文");
  expect(settingsCategoryLabel("build")).toBe("このビルド");
});
