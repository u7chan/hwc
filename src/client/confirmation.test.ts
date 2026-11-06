import { expect, test } from "bun:test";
import type { PaneInteraction } from "../shared/confirmation";
import { confirmationView } from "./confirmation";

const pane = { agent: "codex", chat: true, agentStatus: "idle" as const };
const interaction: PaneInteraction = {
  kind: "codex-folder-trust",
  id: "prompt-1",
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

test("other agents keep their existing input and view behavior", () => {
  expect(confirmationView({ ...state, pane: { ...pane, agent: "pi" } })).toBe("normal");
});
