import { expect, test } from "bun:test";
import {
  agentModelsOutcome,
  toAgentEfforts,
  toAgentModels,
  toLaunchDefaults,
  toModelLabels,
} from "./settings";

test("model candidates keep only their provider and id", () => {
  expect(
    toAgentModels({ models: [{ provider: "example", id: "beam", secret: "hidden" }] }),
  ).toEqual([{ provider: "example", id: "beam" }]);
  expect(toAgentModels({ models: [] })).toEqual([]);
  for (const body of [
    null,
    {},
    { models: "beam" },
    { models: [{ id: "beam" }] },
    { models: [{ provider: "example", id: "--help" }] },
  ]) {
    expect(toAgentModels(body)).toBeNull();
  }
});

test("model labels keep only usable display names", () => {
  expect(
    toModelLabels({ labels: { "claude/opus": "Opus 5.5", "claude/sonnet": "Sonnet 5.5" } }),
  ).toEqual({ "claude/opus": "Opus 5.5", "claude/sonnet": "Sonnet 5.5" });
  expect(toModelLabels({ labels: null })).toBeNull();
  expect(toModelLabels({ labels: {} })).toEqual({});
  for (const body of [null, {}, { labels: "Opus" }, { labels: [] }]) {
    expect(toModelLabels(body)).toBeNull();
  }
  expect(toModelLabels({ labels: { "": "Opus", "claude/opus": "", "claude/sonnet": 3 } })).toEqual(
    {},
  );
});

test("model candidates with namespaced @ IDs remain selectable", () => {
  const model = { provider: "cloudflare-workers-ai", id: "@cf/meta/llama-3.2-3b-instruct" };
  expect(toAgentModels({ models: [model] })).toEqual([model]);
});

test("model lookup distinguishes an unstarted OpenCode service from generic failures", () => {
  expect(agentModelsOutcome(502, { error: "opencode_not_running" })).toBe("opencode_not_running");
  expect(agentModelsOutcome(502, { error: "models_unavailable" })).toBeNull();
  expect(agentModelsOutcome(502, { error: "/private/path: credentials" })).toBeNull();
  expect(agentModelsOutcome(502, null)).toBeNull();
  expect(agentModelsOutcome(200, { error: "opencode_not_running" })).toBeNull();
  expect(agentModelsOutcome(403, { error: "opencode_not_running" })).toBeNull();
  expect(agentModelsOutcome(200, { models: [] })).toEqual([]);
  const models = [{ provider: "example", id: "beam" }];
  expect(agentModelsOutcome(200, { models })).toEqual(models);
  expect(agentModelsOutcome(502, { models })).toBeNull();
});

test("effort choices preserve native names and order rather than translating them to a common scale", () => {
  expect(toAgentEfforts({ efforts: ["none", "xhigh", "max", "じっくり review", "xhigh"] })).toEqual(
    ["none", "xhigh", "max", "じっくり review"],
  );
  expect(toAgentEfforts({ efforts: [] })).toEqual([]);
  for (const body of [
    null,
    {},
    { efforts: "high" },
    { efforts: [null] },
    { efforts: [""] },
    { efforts: ["a\nb"] },
  ]) {
    expect(toAgentEfforts(body)).toBeNull();
  }
});

test("launch defaults are read only from a defaults object", () => {
  const defaults = { claude: { model: { provider: "example", id: "beam" }, effort: null } };
  expect(toLaunchDefaults({ defaults })).toEqual(defaults);
  expect(toLaunchDefaults({ defaults: {} })).toEqual({});
  // 読めない形は既定なしに倒し、作成ダイアログを空の選択で開く。
  for (const body of [null, {}, { defaults: null }, { defaults: [] }, { defaults: "claude" }]) {
    expect(toLaunchDefaults(body)).toBeNull();
  }
});
