import { expect, test } from "bun:test";
import { FOLDER_TRUST_SCREEN, PI_TRUST_SCREEN } from "../../e2e/fixtures/folder-trust";
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

const piPane: PaneState = { ...pane, agent: "pi" };

test("the complete Codex folder disclosure identifies the directory being trusted", () => {
  expect(parseFolderTrust("codex", FOLDER_TRUST_SCREEN)).toEqual({
    directory: "/workspace/acme-dashboard",
  });
});

test.each([
  ["Quit", "quit"],
  ["Keep current directory", "cancel"],
  ["Back to Agent Command Center", "back"],
])("the %s variant still requires Trust and continue to be selected", (cancel, footer) => {
  expect(
    parseFolderTrust(
      "codex",
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
  expect(parseFolderTrust("codex", screen)).toEqual({ directory: "/workspace" });
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
    expect(parseFolderTrust("codex", screen)).toBeNull();
  },
);

test("the complete Pi project trust prompt identifies the directory being trusted", () => {
  expect(parseFolderTrust("pi", PI_TRUST_SCREEN)).toEqual({
    directory: "/workspace/acme-dashboard",
  });
});

test("a Pi prompt wrapped by a narrow terminal is still approvable", () => {
  const wrapped = PI_TRUST_SCREEN.replace(
    "and execute project extensions.",
    "and execute\n project extensions.",
  ).replace("Trust parent folder (/workspace)", "Trust parent folder\n   (/workspace)");
  expect(parseFolderTrust("pi", wrapped)).toEqual({ directory: "/workspace/acme-dashboard" });
});

test.each([
  PI_TRUST_SCREEN.replace("→ Trust", "  Trust").replace("Do not trust\n", "→ Do not trust\n"),
  PI_TRUST_SCREEN.replace("This allows pi", "This lets pi"),
  PI_TRUST_SCREEN.replace("↑↓ navigate", "↑↓ move"),
  PI_TRUST_SCREEN.replace("   Trust parent folder (/workspace)\n", ""),
  PI_TRUST_SCREEN.replace("Trust (this session only)", "Trust for this session"),
  PI_TRUST_SCREEN.replace("/workspace/acme-dashboard", "/workspace/acme…board"),
  PI_TRUST_SCREEN.replace("/workspace/acme-dashboard", "/workspace/acme\n-dashboard"),
  PI_TRUST_SCREEN.replace("/workspace/acme-dashboard", "workspace/acme-dashboard"),
  `Earlier output\n${PI_TRUST_SCREEN}`,
  `${PI_TRUST_SCREEN}\nUnexpected error`,
])("incomplete, ambiguous or non-selected Pi prompts are not approvable: %j", (screen) => {
  expect(parseFolderTrust("pi", screen)).toBeNull();
});

test("a prompt for another agent is never approvable", () => {
  expect(parseFolderTrust("pi", FOLDER_TRUST_SCREEN)).toBeNull();
  expect(parseFolderTrust("codex", PI_TRUST_SCREEN)).toBeNull();
});

test("a pane that changes agent gets a new confirmation identity", async () => {
  const { client, setScreen } = setup();
  const codex = await client.inspect(pane);
  if (codex?.kind !== "folder-trust") throw new Error("missing confirmation");
  setScreen(PI_TRUST_SCREEN);
  const pi = await client.inspect(piPane);
  expect(pi).toMatchObject({ kind: "folder-trust", agent: "pi", submitted: false });
  expect(pi).not.toHaveProperty("id", codex.id);
});

test("a normal Pi conversation that mentions the dialog footer is not a trust prompt", async () => {
  const { client } = setup(
    {},
    "› Ask pi to do anything\n\n↑↓ navigate  enter select  escape/ctrl+c cancel\n",
  );
  expect(await client.inspect({ ...piPane, chat: true })).toBeNull();
});

test("a chatless pane that only shows a dialog footer stays read-only", async () => {
  const { client } = setup(
    {},
    "› Ask pi to do anything\n\n↑↓ navigate  enter select  escape/ctrl+c cancel\n",
  );
  expect(await client.inspect(piPane)).toEqual({ kind: "terminal" });
});

test("a trust prompt split by a narrow terminal stays read-only before the session starts", async () => {
  const { client } = setup(
    {},
    PI_TRUST_SCREEN.replace("Trust project folder?", "Trust project\n folder?"),
  );
  expect(await client.inspect(piPane)).toEqual({ kind: "terminal" });
  // 会話が始まっているペインでは、同じ文字列が出ているだけで入力欄を閉じない。
  expect(await client.inspect({ ...piPane, chat: true })).toBeNull();
});

test("a screen that only mentions the title is not a confirmation", async () => {
  const { client } = setup({}, "› Ask pi to do anything\n\nTrust project folder?\n");
  expect(await client.inspect(piPane)).toBeNull();
});

test("a Pi prompt with an unfamiliar disclosure stays read-only", async () => {
  const { client } = setup({}, PI_TRUST_SCREEN.replace("This allows pi", "This allows Pi"));
  expect(await client.inspect(piPane)).toEqual({ kind: "terminal" });
});

function setup(
  overrides: Partial<Pick<PaneClient, "read" | "confirmFolderTrust">> = {},
  initial = FOLDER_TRUST_SCREEN,
) {
  let screen = initial;
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
    kind: "folder-trust",
    agent: "codex",
    directory: "/workspace/acme-dashboard",
    submitted: false,
  });
  expect(await client.inspect(pane)).toEqual(first);
  expect(calls).toEqual([
    { paneId: pane.id, source: "detection" },
    { paneId: pane.id, source: "detection" },
  ]);
});

test("agents without a known trust prompt are not inspected or approved", async () => {
  const { client, calls } = setup();
  expect(await client.inspect({ ...pane, agent: "claude" })).toBeNull();
  expect(await client.inspect({ ...pane, agent: "opencode" })).toBeNull();
  expect(await client.accept({ ...pane, agent: "claude" }, "forged")).toBe("changed");
  expect(calls).toEqual([]);
});

test("terminal reflow keeps the same confirmation identity and submitted state", async () => {
  const { client, setScreen } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "folder-trust") throw new Error("missing confirmation");
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
  if (first?.kind !== "folder-trust") throw new Error("missing confirmation");
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
  expect(next).toMatchObject({ kind: "folder-trust", submitted: false });
  expect(next).not.toHaveProperty("id", first.id);
});

test.each([
  "Codex is ready",
  FOLDER_TRUST_SCREEN.replace("acme-dashboard", "other-project"),
  FOLDER_TRUST_SCREEN.replace("› 1.", "1.").replace("2. Back", "› 2. Back"),
])("a changed prompt never receives Enter from an old approval: %j", async (screen) => {
  const { client, calls, setScreen } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "folder-trust") throw new Error("missing confirmation");
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
  if (first?.kind !== "folder-trust") throw new Error("missing confirmation");
  await expect(client.accept(pane, first.id)).rejects.toThrow("connection lost");
  expect(await client.accept(pane, first.id)).toBe("changed");
  expect(sends).toBe(1);
});

test.each(["", "   ", " \r\n\n "])(
  "an empty detection frame preserves the identity and response lock after an unknown outcome: %j",
  async (screen) => {
    let sends = 0;
    const { client, setScreen } = setup({
      confirmFolderTrust: async () => {
        sends += 1;
        throw new Error("connection lost");
      },
    });
    const first = await client.inspect(pane);
    if (first?.kind !== "folder-trust") throw new Error("missing confirmation");
    await expect(client.accept(pane, first.id)).rejects.toThrow("connection lost");
    setScreen(screen);
    expect(await client.inspect(pane)).toEqual({ kind: "terminal" });
    expect(await client.accept(pane, first.id)).toBe("changed");
    setScreen(FOLDER_TRUST_SCREEN);
    expect(await client.inspect(pane)).toEqual({ ...first, submitted: true });
    expect(await client.accept(pane, first.id)).toBe("changed");
    expect(sends).toBe(1);
    setScreen("Codex is ready");
    expect(await client.inspect(pane)).toBeNull();
  },
);

test("an empty detection frame cannot dismiss an unsubmitted confirmation either", async () => {
  const { client, setScreen } = setup();
  const first = await client.inspect(pane);
  setScreen("");
  expect(await client.inspect(pane)).toEqual({ kind: "terminal" });
  setScreen(FOLDER_TRUST_SCREEN);
  expect(await client.inspect(pane)).toEqual(first);
});

test("closed panes lose their outstanding confirmation identifiers", async () => {
  const { client } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "folder-trust") throw new Error("missing confirmation");
  client.retain([]);
  expect(await client.accept(pane, first.id)).toBe("changed");
});

test("a temporarily incomplete or differently selected prompt does not forget an attempted response", async () => {
  const { client, setScreen, calls } = setup();
  const first = await client.inspect(pane);
  if (first?.kind !== "folder-trust") throw new Error("missing confirmation");
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

test("Pi project trust gets an identifier and is answered with only Enter", async () => {
  const { client, calls } = setup({}, PI_TRUST_SCREEN);
  const first = await client.inspect(piPane);
  expect(first).toMatchObject({
    kind: "folder-trust",
    agent: "pi",
    directory: "/workspace/acme-dashboard",
    submitted: false,
  });
  if (first?.kind !== "folder-trust") throw new Error("missing confirmation");
  expect(await client.accept(piPane, first.id)).toBe("done");
  expect(calls.filter((call) => "confirm" in (call as object))).toEqual([
    { confirm: { paneId: piPane.id } },
  ]);
  expect(await client.inspect(piPane)).toEqual({ ...first, submitted: true });
});

test("an incomplete Pi prompt falls back to the terminal without an identifier", async () => {
  const { client } = setup({}, PI_TRUST_SCREEN.replace("escape/ctrl+c cancel", "esc cancel"));
  expect(await client.inspect(piPane)).toEqual({ kind: "terminal" });
});
