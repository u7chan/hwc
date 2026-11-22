import { describe, expect, test } from "bun:test";
import type { PaneState } from "../server/herdr/state";
import {
  chooseSwitchEffort,
  chooseSwitchModel,
  currentCandidate,
  modelSwitchBlockReason,
  switchFailureNotice,
} from "./model-switch";

const candidates = ["fable", "opus", "sonnet", "haiku"].map((id) => ({ provider: "claude", id }));
const opus = candidates[1]!;
const sonnet = candidates[2]!;

const pane = (overrides: Partial<PaneState>): PaneState =>
  ({ agent: "claude", chat: true, agentStatus: "idle", ...overrides }) as PaneState;

describe("modelSwitchBlockReason", () => {
  test("an idle or finished Claude pane can be switched", () => {
    expect(modelSwitchBlockReason(pane({ agentStatus: "idle" }))).toBeNull();
    expect(modelSwitchBlockReason(pane({ agentStatus: "done" }))).toBeNull();
  });

  test("a running reply is not interrupted by a switch", () => {
    expect(modelSwitchBlockReason(pane({ agentStatus: "working" }))).toBe("実行中は使えません");
  });

  test("a pane waiting for an answer is left to the answer", () => {
    expect(modelSwitchBlockReason(pane({ agentStatus: "blocked" }))).toBe(
      "応答待ちの間は使えません",
    );
  });

  test("a status that cannot be read is not guessed at", () => {
    expect(modelSwitchBlockReason(pane({ agentStatus: "unknown" }))).toBe("状態を確認できません");
  });

  test.each([
    ["another agent", { agent: "pi" as const }],
    ["a pane whose conversation cannot be read", { chat: false }],
    ["a shell", { agent: null }],
  ])("%s is not offered", (_name, overrides) => {
    expect(modelSwitchBlockReason(pane(overrides))).toBe("このペインでは使えません");
  });
});

describe("currentCandidate", () => {
  test.each([
    ["opus", "opus"],
    ["claude-opus-5-5", "opus"],
    ["claude-fable-5-2[1m]", "fable"],
  ])("%s starts on %s", (current, id) => {
    expect(currentCandidate(candidates, current)?.id).toBe(id);
  });

  test("a model that is not Claude's has no starting choice", () => {
    expect(currentCandidate(candidates, "deepseek-v4-flash")).toBeNull();
    expect(currentCandidate(candidates, null)).toBeNull();
    expect(currentCandidate(undefined, "opus")).toBeNull();
    expect(currentCandidate(null, "opus")).toBeNull();
  });
});

describe("chooseSwitchModel", () => {
  test("the chosen model wins over the current one", () => {
    expect(chooseSwitchModel(candidates, sonnet, "claude-opus-5-5")).toEqual(sonnet);
  });

  test("with nothing chosen the current model is selected", () => {
    expect(chooseSwitchModel(candidates, null, "claude-opus-5-5")).toEqual(opus);
  });

  test("a choice that is no longer a candidate falls back to the current model", () => {
    expect(chooseSwitchModel([opus], sonnet, "claude-opus-5-5")).toEqual(opus);
  });

  test("nothing is chosen while the candidates are loading or failed", () => {
    expect(chooseSwitchModel(undefined, sonnet, "opus")).toBeNull();
    expect(chooseSwitchModel(null, sonnet, "opus")).toBeNull();
  });
});

describe("chooseSwitchEffort", () => {
  const levels = ["low", "medium", "high", "xhigh", "max"];

  test("the chosen effort is kept across a model change while it is still offered", () => {
    expect(chooseSwitchEffort(levels, "max", "high")).toBe("max");
  });

  test("otherwise the effort shown now is the starting choice", () => {
    expect(chooseSwitchEffort(levels, null, "high")).toBe("high");
    expect(chooseSwitchEffort(["low"], "max", "high")).toBeNull();
  });

  test("nothing is chosen while the candidates are loading, failed or empty", () => {
    expect(chooseSwitchEffort(undefined, "high", "high")).toBeNull();
    expect(chooseSwitchEffort(null, "high", "high")).toBeNull();
    expect(chooseSwitchEffort([], "high", "high")).toBeNull();
  });
});

describe("switchFailureNotice", () => {
  test("tells a refusal from a switch that could not be confirmed", () => {
    expect(switchFailureNotice(409)).toContain("今は切り替えられません");
    expect(switchFailureNotice(400)).toContain("選び直して");
    for (const status of [0, 502, 500]) {
      expect(switchFailureNotice(status)).toContain("端末で確かめて");
    }
  });
});
