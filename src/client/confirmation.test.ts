import { expect, test } from "bun:test";
import type { PaneInteraction } from "../shared/confirmation";
import { confirmationView } from "./confirmation";

const pane = { agent: "codex", chat: true, agentStatus: "idle" as const };
const interaction: PaneInteraction = {
  kind: "folder-trust",
  id: "prompt-1",
  agent: "codex",
  directory: "/workspace/demo",
  submitted: false,
};
const state = { pane, interaction, dismissedId: null, failed: false };

test("a recognized confirmation replaces even a readable saved conversation", () => {
  expect(confirmationView(state)).toBe("confirm");
  expect(confirmationView({ ...state, pane: { ...pane, chat: false } })).toBe("confirm");
});

test("terminal handoff suppresses the same confirmation, but not a different one", () => {
  expect(confirmationView({ ...state, dismissedId: "prompt-1" })).toBe("terminal");
  expect(confirmationView({ ...state, dismissedId: "older-prompt" })).toBe("confirm");
});

test("sending a response does not optimistically restore the composer", () => {
  expect(confirmationView({ ...state, interaction: { ...interaction, submitted: true } })).toBe(
    "confirm",
  );
});

test("unsupported and unreadable prompts stay in a read-only terminal view", () => {
  expect(confirmationView({ ...state, interaction: { kind: "terminal" } })).toBe("terminal");
  expect(confirmationView({ ...state, failed: true })).toBe("terminal");
});

test("Codex accepts its first message before a conversation id is available", () => {
  const initial = { ...state, pane: { ...pane, chat: false }, interaction: null };
  expect(confirmationView(initial)).toBe("normal");
  expect(confirmationView({ ...initial, interaction })).toBe("confirm");
  expect(confirmationView({ ...initial, interaction: { kind: "terminal" } })).toBe("terminal");
  expect(confirmationView({ ...initial, failed: true })).toBe("terminal");
  expect(confirmationView({ ...initial, pane: { ...initial.pane, agentStatus: "blocked" } })).toBe(
    "terminal",
  );
});

test("chat returns only after the confirmation and blocked state have cleared", () => {
  expect(confirmationView({ ...state, interaction: null })).toBe("normal");
  expect(
    confirmationView({ ...state, interaction: null, pane: { ...pane, agentStatus: "blocked" } }),
  ).toBe("terminal");
});

test("Pi shows the confirmation while the idle trust prompt is on screen", () => {
  const piPane = { ...pane, agent: "pi", chat: false };
  const pi = { ...interaction, agent: "pi" as const };
  expect(
    confirmationView({ pane: piPane, interaction: pi, dismissedId: null, failed: false }),
  ).toBe("confirm");
  expect(
    confirmationView({ pane: piPane, interaction: null, dismissedId: null, failed: false }),
  ).toBe("normal");
  expect(
    confirmationView({
      pane: { ...piPane, agentStatus: "blocked" },
      interaction: null,
      dismissedId: null,
      failed: false,
    }),
  ).toBe("terminal");
});

test("agents without a known trust prompt keep their existing view behavior", () => {
  for (const agent of ["claude", "opencode", null] as const) {
    expect(
      confirmationView({ ...state, pane: { ...pane, agent }, interaction: { kind: "terminal" } }),
    ).toBe("normal");
  }
});
