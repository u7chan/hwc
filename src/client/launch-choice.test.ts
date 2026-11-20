import { describe, expect, test } from "bun:test";
import type { LaunchDefault } from "../shared/launch-defaults";
import {
  canLaunch,
  chooseEffort,
  chooseModel,
  type ModelCandidates,
  savedEffortFor,
} from "./launch-choice";

const sonnet = { provider: "claude", id: "sonnet" };
const opus = { provider: "claude", id: "opus" };
const haiku = { provider: "claude", id: "haiku" };
const candidates = [sonnet, opus];
const saved: LaunchDefault = { model: sonnet, effort: "high" };

describe("the model to launch", () => {
  test("without a default, nothing is selected until the user picks a model", () => {
    expect(chooseModel(candidates, null, null)).toBeNull();
    expect(chooseModel(candidates, null, opus)).toEqual(opus);
  });

  test("the default model is selected when it is a candidate", () => {
    expect(chooseModel(candidates, saved, null)).toEqual(sonnet);
  });

  test("a default model that is no longer a candidate is not selected", () => {
    expect(chooseModel(candidates, { model: haiku, effort: null }, null)).toBeNull();
  });

  test("the user's pick wins over the default, even when the default arrives later", () => {
    expect(chooseModel(candidates, null, opus)).toEqual(opus);
    expect(chooseModel(candidates, saved, opus)).toEqual(opus);
  });

  test("nothing is selected while candidates are loading or unavailable", () => {
    const reads: ModelCandidates[] = [undefined, null, "opencode_not_running", []];
    for (const read of reads) {
      expect(chooseModel(read, saved, opus)).toBeNull();
    }
  });
});

describe("the effort to launch", () => {
  test("the default effort comes with the default model", () => {
    expect(chooseEffort(["low", "high"], sonnet, saved, null)).toBe("high");
  });

  test("a default effort that is no longer a candidate is not selected", () => {
    expect(chooseEffort(["low", "medium"], sonnet, saved, null)).toBeNull();
  });

  test("the default effort is not carried over to another model", () => {
    expect(chooseEffort(["low", "high"], opus, saved, null)).toBeNull();
  });

  test("the user's pick wins over the default effort", () => {
    expect(chooseEffort(["low", "high"], sonnet, saved, "low")).toBe("low");
  });

  test("a model without effort support has no effort", () => {
    expect(chooseEffort([], sonnet, saved, null)).toBeNull();
  });

  test("nothing is selected without a model or while efforts are loading or unavailable", () => {
    expect(chooseEffort(["low", "high"], null, saved, "low")).toBeNull();
    expect(chooseEffort(undefined, sonnet, saved, "low")).toBeNull();
    expect(chooseEffort(null, sonnet, saved, "low")).toBeNull();
  });

  test("the default effort is labeled only for the default model", () => {
    expect(savedEffortFor(sonnet, saved)).toBe("high");
    expect(savedEffortFor(opus, saved)).toBeNull();
    expect(savedEffortFor(sonnet, null)).toBeNull();
    expect(savedEffortFor(null, saved)).toBeNull();
  });
});

describe("whether the agent can be launched", () => {
  test("a model and an effort are required when the model supports effort", () => {
    expect(canLaunch(sonnet, ["low", "high"], "high")).toBe(true);
    expect(canLaunch(sonnet, ["low", "high"], null)).toBe(false);
  });

  test("a model without effort support launches without an effort", () => {
    expect(canLaunch(sonnet, [], null)).toBe(true);
  });

  test("no launch without a model", () => {
    expect(canLaunch(null, ["low"], "low")).toBe(false);
  });

  test("no launch while efforts are loading or could not be read", () => {
    expect(canLaunch(sonnet, undefined, null)).toBe(false);
    expect(canLaunch(sonnet, null, null)).toBe(false);
  });
});
