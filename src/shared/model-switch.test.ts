import { describe, expect, test } from "bun:test";
import {
  claudeModelFamily,
  effortCommand,
  modelCommand,
  modelSwitchPlan,
  parseModelSwitchRequest,
} from "./model-switch";

const opus = { provider: "claude", id: "opus" };

describe("parseModelSwitchRequest", () => {
  test("takes a Claude alias and an effort", () => {
    expect(parseModelSwitchRequest({ model: opus, effort: "high" })).toEqual({
      model: opus,
      effort: "high",
    });
  });

  test("keeps only the fields it knows", () => {
    expect(parseModelSwitchRequest({ model: { ...opus, extra: 1 }, effort: "low", x: 1 })).toEqual({
      model: opus,
      effort: "low",
    });
  });

  test.each([
    ["not an object", null],
    ["an array", []],
    ["no model", { effort: "high" }],
    ["no effort", { model: opus }],
    ["another agent's provider", { model: { provider: "openai", id: "opus" }, effort: "high" }],
    [
      "a model that is not an alias",
      { model: { provider: "claude", id: "claude-opus-5-5" }, effort: "high" },
    ],
    ["an effort with a space", { model: opus, effort: "high now" }],
    ["an effort that can start a second command", { model: opus, effort: "high\n/clear" }],
    ["an upper-case effort", { model: opus, effort: "High" }],
    ["an empty effort", { model: opus, effort: "" }],
    ["a non-string effort", { model: opus, effort: 3 }],
  ])("rejects %s", (_name, body) => {
    expect(parseModelSwitchRequest(body)).toBeNull();
  });
});

describe("claudeModelFamily", () => {
  test.each([
    ["opus", "opus"],
    ["claude-opus-5-5", "opus"],
    ["claude-fable-5-2[1m]", "fable"],
    ["claude-haiku-5-5", "haiku"],
    ["deepseek-v4-flash", null],
    ["claude-unknown-5-5", null],
  ])("%s is %s", (id, family) => {
    expect(claudeModelFamily(id)).toBe(family);
  });
});

describe("modelSwitchPlan", () => {
  const request = { model: opus, effort: "high" };

  test("changing only the effort leaves the model alone", () => {
    expect(modelSwitchPlan({ model: "claude-opus-5-5", effort: "low" }, request)).toEqual({
      model: false,
      effort: true,
    });
  });

  test("changing nothing sends nothing", () => {
    expect(modelSwitchPlan({ model: "claude-opus-5-5", effort: "high" }, request)).toEqual({
      model: false,
      effort: false,
    });
  });

  test("a launch-time alias counts as the same family", () => {
    expect(modelSwitchPlan({ model: "opus", effort: "high" }, request)).toEqual({
      model: false,
      effort: false,
    });
  });

  test("a new model always sends the effort too, even if the shown effort matches", () => {
    expect(modelSwitchPlan({ model: "claude-haiku-5-5", effort: "high" }, request)).toEqual({
      model: true,
      effort: true,
    });
  });

  test("an unknown current model is treated as a change", () => {
    expect(modelSwitchPlan({ model: null, effort: null }, request)).toEqual({
      model: true,
      effort: true,
    });
    expect(modelSwitchPlan({ model: "deepseek-v4-flash", effort: "high" }, request)).toEqual({
      model: true,
      effort: true,
    });
  });
});

test("commands are the alias and the level, nothing else", () => {
  expect(modelCommand(opus)).toBe("/model opus");
  expect(effortCommand("xhigh")).toBe("/effort xhigh");
});
