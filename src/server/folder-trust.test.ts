import { expect, test } from "bun:test";
import { FOLDER_TRUST_SCREEN } from "../../e2e/fixtures/folder-trust";
import { createFolderTrust, parseFolderTrust } from "./folder-trust";
import type { PaneClient } from "./herdr/panes";
import type { PaneState } from "./herdr/state";

const pane: PaneState = {
  id: "w1:p1",
  title: null,
  label: null,
  agent: "codex",
  agentStatus: "idle",
  focused: true,
  chat: false,
};

test("the complete Codex folder disclosure identifies the directory being trusted", () => {
  expect(parseFolderTrust(FOLDER_TRUST_SCREEN)).toEqual({ directory: "/workspace/acme-dashboard" });
});

test.each([
  ["Quit", "quit"],
  ["Keep current directory", "cancel"],
  ["Back to Agent Command Center", "back"],
])("the %s variant still requires Trust and continue to be selected", (cancel, footer) => {
  expect(
    parseFolderTrust(
      FOLDER_TRUST_SCREEN.replace("Back to Agent Command Center", cancel).replace(
        "esc back",
        `esc ${footer}`,
      ),
    ),
  ).not.toBeNull();
});

test("the repository-root warning changes the displayed trust scope, not just the current directory", () => {
  const screen =
    FOLDER_TRUST_SCREEN +
    `
  Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:
  /workspace
`;
  expect(parseFolderTrust(screen)).toEqual({ directory: "/workspace" });
});

test.each([
  FOLDER_TRUST_SCREEN.replace("› 1.", "1.").replace("2. Back", "› 2. Back"),
  FOLDER_TRUST_SCREEN.replace("› 1.", "> 1."),
  FOLDER_TRUST_SCREEN.replace("Your trust decision will be saved.", ""),
  FOLDER_TRUST_SCREEN.replace("enter continue · esc back", ""),
  FOLDER_TRUST_SCREEN.replace("/workspace/acme-dashboard", "/workspace/acme…board"),
  FOLDER_TRUST_SCREEN.replace("/workspace/acme-dashboard", "/workspace/acme\n-dashboard"),
  FOLDER_TRUST_SCREEN.replace("/workspace/acme-dashboard", "workspace/acme-dashboard"),
  FOLDER_TRUST_SCREEN.replace("/workspace/acme-dashboard", "/workspace/\x1bacme-dashboard"),
  `Earlier output\n${FOLDER_TRUST_SCREEN}`,
  `${FOLDER_TRUST_SCREEN}\nUnexpected error`,
  `${FOLDER_TRUST_SCREEN}\nNote: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:\n/work…ace`,
])(
  "incomplete, ambiguous, historical and non-selected prompts are not approvable: %j",
  (screen) => {
    expect(parseFolderTrust(screen)).toBeNull();
  },
);

function setup(overrides: Partial<Pick<PaneClient, "read" | "confirmFolderTrust">> = {}) {
  let screen = FOLDER_TRUST_SCREEN;
  const calls: unknown[] = [];
  const client = createFolderTrust({
    read: async (options) => {
      calls.push(options);
      return { paneId: options.paneId, text: screen, truncated: false, revision: 0 };
    },
    confirmFolderTrust: async (options) => {
      calls.push({ confirm: options });
    },
    ...overrides,
  });
  return {
    client,
    calls,
    setScreen: (value: string) => {
      screen = value;
    },
  };
}

test("inspection uses the detection buffer even before there is a conversation", async () => {
  const { client, calls } = setup();
  const first = await client.inspect(pane);
  expect(first).toMatchObject({
    kind: "codex-folder-trust",
    directory: "/workspace/acme-dashboard",
    submitted: false,
  });
  expect(await client.inspect(pane)).toEqual(first);
  expect(calls).toEqual([
    { paneId: pane.id, source: "detection" },
    { paneId: pane.id, source: "detection" },
  ]);
});

test("non-Codex panes are not inspected or approved", async () => {
  const { client, calls } = setup();
  expect(await client.inspect({ ...pane, agent: "claude" })).toBeNull();
  expect(await client.accept({ ...pane, agent: "claude" }, "forged")).toBe("changed");
  expect(calls).toEqual([]);
});

test("terminal reflow keeps the same confirmation identity and submitted state", async () => {
  const { client, setScreen } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "codex-folder-trust") throw new Error("missing confirmation");
  await client.accept(pane, first.id);
  setScreen(FOLDER_TRUST_SCREEN.replace("Folder settings can", "Folder settings\n  can"));
  expect(await client.inspect(pane)).toEqual({ ...first, submitted: true });
});

test("a partial trust screen falls back to terminal without an approval identifier", async () => {
  const { client, setScreen } = setup();
  setScreen(FOLDER_TRUST_SCREEN.replace("Your trust decision will be saved.", ""));
  expect(await client.inspect(pane)).toEqual({ kind: "terminal" });
});

test("a truncated detection buffer cannot be approved", async () => {
  const { client } = setup({
    read: async () => ({
      paneId: pane.id,
      text: FOLDER_TRUST_SCREEN,
      truncated: true,
      revision: 0,
    }),
  });
  expect(await client.inspect(pane)).toEqual({ kind: "terminal" });
});

test("approval rechecks the screen, sends only once and remains submitted until the prompt disappears", async () => {
  const { client, calls, setScreen } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "codex-folder-trust") throw new Error("missing confirmation");
  const results = await Promise.all([client.accept(pane, first.id), client.accept(pane, first.id)]);
  expect(results).toEqual(["done", "changed"]);
  expect(calls.filter((call) => "confirm" in (call as object))).toEqual([
    { confirm: { paneId: pane.id } },
  ]);
  expect(await client.inspect(pane)).toEqual({ ...first, submitted: true });
  setScreen("Codex is ready");
  expect(await client.inspect(pane)).toBeNull();
  setScreen(FOLDER_TRUST_SCREEN);
  const next = await client.inspect(pane);
  expect(next).toMatchObject({ kind: "codex-folder-trust", submitted: false });
  expect(next).not.toHaveProperty("id", first.id);
});

test.each([
  "Codex is ready",
  FOLDER_TRUST_SCREEN.replace("acme-dashboard", "other-project"),
  FOLDER_TRUST_SCREEN.replace("› 1.", "1.").replace("2. Back", "› 2. Back"),
])("a changed prompt never receives Enter from an old approval: %j", async (screen) => {
  const { client, calls, setScreen } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "codex-folder-trust") throw new Error("missing confirmation");
  setScreen(screen);
  expect(await client.accept(pane, first.id)).toBe("changed");
  expect(calls.filter((call) => "confirm" in (call as object))).toEqual([]);
});

test("an unknown send outcome cannot trigger another Enter", async () => {
  let sends = 0;
  const { client } = setup({
    confirmFolderTrust: async () => {
      sends += 1;
      throw new Error("connection lost");
    },
  });
  const first = await client.inspect(pane);
  if (first?.kind !== "codex-folder-trust") throw new Error("missing confirmation");
  await expect(client.accept(pane, first.id)).rejects.toThrow("connection lost");
  expect(await client.accept(pane, first.id)).toBe("changed");
  expect(sends).toBe(1);
});

test("closed panes lose their outstanding confirmation identifiers", async () => {
  const { client } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "codex-folder-trust") throw new Error("missing confirmation");
  client.retain([]);
  expect(await client.accept(pane, first.id)).toBe("changed");
});

test("a temporarily incomplete or differently selected prompt does not forget an attempted response", async () => {
  const { client, setScreen, calls } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "codex-folder-trust") throw new Error("missing confirmation");
  await client.accept(pane, first.id);
  for (const screen of [
    "enter continue · esc back",
    FOLDER_TRUST_SCREEN.replace("› 1.", "1.").replace("2. Back", "› 2. Back"),
  ]) {
    setScreen(screen);
    expect(await client.inspect(pane)).toEqual({ kind: "terminal" });
    setScreen(FOLDER_TRUST_SCREEN);
    expect(await client.inspect(pane)).toEqual({ ...first, submitted: true });
    expect(await client.accept(pane, first.id)).toBe("changed");
  }
  expect(calls.filter((call) => "confirm" in (call as object))).toHaveLength(1);
});
