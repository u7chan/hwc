import { expect, test } from "bun:test";
import { claudeModelName, isClaudeAlias, modelLabel } from "./agents";

test("Claude のエイリアスは family 名だけにする。解決先の版は起動するまで分からない", () => {
  expect(claudeModelName("opus")).toBe("Opus");
  expect(claudeModelName("fable")).toBe("Fable");
  expect(isClaudeAlias("opus")).toBe(true);
});

test("Claude のモデル id は family と版の表示名にする", () => {
  expect(claudeModelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(claudeModelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
  expect(claudeModelName("claude-haiku-5-5")).toBe("Haiku 5.5");
  expect(claudeModelName("claude-fable-5-2")).toBe("Fable 5.2");
  expect(isClaudeAlias("claude-opus-5-5")).toBe(false);
});

test("日付つきの id は日付を表示名に含めない", () => {
  expect(claudeModelName("claude-opus-4-1-20250805")).toBe("Opus 4.1");
});

test("読めない id は、そのまま返す", () => {
  // 日付を minor と読んで `Opus 4.20250514` にしない。
  expect(claudeModelName("claude-opus-4-20250514")).toBe("claude-opus-4-20250514");
  expect(claudeModelName("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet-20241022");
  expect(claudeModelName("claude-opus-5-5[1m]")).toBe("claude-opus-5-5[1m]");
  expect(claudeModelName("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  expect(claudeModelName("<synthetic>")).toBe("<synthetic>");
});

test("モデルのラベルは Claude を表示名にし、Codex / OpenCode は provider を落とし、Pi は残す", () => {
  expect(modelLabel("claude", { provider: "claude", id: "sonnet" })).toBe("Sonnet");
  expect(modelLabel("pi", { provider: "opencode-go", id: "model-a" })).toBe("opencode-go/model-a");
  expect(modelLabel("codex", { provider: "openai", id: "gpt-x" })).toBe("gpt-x");
  expect(modelLabel("opencode", { provider: "opencode-go", id: "beam-free" })).toBe("beam-free");
});
