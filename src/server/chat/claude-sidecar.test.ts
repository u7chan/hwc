import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHook,
  nextSidecar,
  readSidecar,
  SIDECAR_TTL_MS,
  sidecarPath,
  type Sidecar,
} from "./claude-sidecar";

const SESSION = "5f0c2f6e-8b1a-4c0d-9d7e-2a6f1c3b4d5e";
const NOW = Date.parse("2026-01-01T09:00:00.000Z");

const questions = [
  {
    question: "好きな色は？",
    header: "色",
    multiSelect: false,
    options: [
      { label: "赤", description: "赤い" },
      { label: "青", description: "青い" },
    ],
  },
];

function hook(event: string, extra: Record<string, unknown> = {}) {
  return { session_id: SESSION, hook_event_name: event, ...extra };
}

const started: Sidecar = {
  v: 1,
  sessionId: SESSION,
  at: NOW - 1_000,
  toolUseId: "toolu_bash",
  tool: "Bash",
  pending: null,
};

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hwc-sidecar-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("AskUserQuestion is waiting for a person as soon as the tool starts", () => {
  const action = nextSidecar(
    hook("PreToolUse", {
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_ask",
      tool_input: { questions },
    }),
    null,
    NOW,
  );

  expect(action).toEqual({
    kind: "write",
    sidecar: {
      v: 1,
      sessionId: SESSION,
      at: NOW,
      toolUseId: "toolu_ask",
      tool: "AskUserQuestion",
      pending: {
        kind: "question",
        toolUseId: "toolu_ask",
        tool: "AskUserQuestion",
        questions: [
          {
            question: "好きな色は？",
            header: "色",
            multiSelect: false,
            options: [
              { label: "赤", description: "赤い" },
              { label: "青", description: "青い" },
            ],
          },
        ],
      },
    },
  });
});

test("a malformed question is recorded without a card", () => {
  const action = nextSidecar(
    hook("PreToolUse", {
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_ask",
      tool_input: { questions: [] },
    }),
    null,
    NOW,
  );

  expect(action).toMatchObject({ kind: "write", sidecar: { pending: null } });
});

test("any other tool is only remembered until a permission request shows a person is needed", () => {
  const action = nextSidecar(
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_use_id: "toolu_bash",
      tool_input: { command: "rm -rf build" },
    }),
    null,
    NOW,
  );

  // 承認が要るかはまだ分からない。入力も保存しない。
  expect(action).toEqual({
    kind: "write",
    sidecar: {
      v: 1,
      sessionId: SESSION,
      at: NOW,
      toolUseId: "toolu_bash",
      tool: "Bash",
      pending: null,
    },
  });
});

test("a permission request takes the tool use id from the tool that just started", () => {
  const action = nextSidecar(
    hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "touch ./probe" } }),
    started,
    NOW,
  );

  expect(action).toEqual({
    kind: "write",
    sidecar: {
      ...started,
      at: NOW,
      pending: { kind: "tool", toolUseId: "toolu_bash", tool: "Bash", summary: "touch ./probe" },
    },
  });
});

test("a permission request never saves the body of a Write", () => {
  const action = nextSidecar(
    hook("PermissionRequest", {
      tool_name: "Write",
      tool_input: { file_path: "/work/a.txt", content: "SECRET-TOKEN" },
    }),
    { ...started, tool: "Write", toolUseId: "toolu_write" },
    NOW,
  );

  expect(JSON.stringify(action)).not.toContain("SECRET-TOKEN");
  expect(action).toMatchObject({
    kind: "write",
    sidecar: { pending: { summary: "/work/a.txt" } },
  });
});

test.each([
  ["no tool was recorded", null],
  ["another tool was recorded", { ...started, tool: "Read" }],
  ["another session was recorded", { ...started, sessionId: "another-session" }],
])("a permission request is ignored when %s", (_name, current) => {
  const action = nextSidecar(
    hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }),
    current,
    NOW,
  );

  // 別のツールの id を付けて、誤った待ちを出すより、カードを出さない。
  expect(action).toEqual({ kind: "none" });
});

test("a permission request for AskUserQuestion changes nothing", () => {
  const action = nextSidecar(
    hook("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: { questions } }),
    { ...started, tool: "AskUserQuestion" },
    NOW,
  );

  expect(action).toEqual({ kind: "none" });
});

test.each(["PostToolUse", "PostToolUseFailure"])(
  "%s of the recorded tool clears the wait",
  (event) => {
    expect(nextSidecar(hook(event, { tool_use_id: "toolu_bash" }), started, NOW)).toEqual({
      kind: "clear",
    });
  },
);

test("a tool finishing in parallel does not clear the wait of another tool", () => {
  const action = nextSidecar(hook("PostToolUse", { tool_use_id: "toolu_other" }), started, NOW);

  expect(action).toEqual({ kind: "none" });
});

test.each(["UserPromptSubmit", "Stop", "SessionEnd"])(
  "%s clears a wait that Esc left behind",
  (event) => {
    expect(nextSidecar(hook(event), started, NOW)).toEqual({ kind: "clear" });
  },
);

test("events from a sub-agent never replace the main session's wait", () => {
  const action = nextSidecar(
    hook("PreToolUse", {
      agent_id: "agent-1",
      tool_name: "Bash",
      tool_use_id: "toolu_sub",
      tool_input: { command: "ls" },
    }),
    started,
    NOW,
  );

  expect(action).toEqual({ kind: "none" });
});

test.each([
  ["not an object", "text"],
  ["without a session id", { hook_event_name: "Stop" }],
  ["with a session id that leaves the directory", hook("Stop", { session_id: "../escape" })],
  ["with an event nobody listens to", hook("Notification")],
  ["PreToolUse without a tool use id", hook("PreToolUse", { tool_name: "Bash" })],
])("input %s changes nothing", (_name, input) => {
  expect(nextSidecar(input, started, NOW)).toEqual({ kind: "none" });
});

test("a question survives a round trip through the file", async () => {
  await withRoot(async (root) => {
    await applyHook(
      root,
      hook("PreToolUse", {
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_ask",
        tool_input: { questions },
      }),
      NOW,
    );

    const sidecar = await readSidecar(root, SESSION);
    expect(sidecar?.pending).toMatchObject({ kind: "question", toolUseId: "toolu_ask" });

    // 書き込み途中の一時ファイルは残らない。
    expect(await readdir(root)).toEqual([`${SESSION}.json`]);
  });
});

test("approval after a started tool yields a tool card, and its result removes the file", async () => {
  await withRoot(async (root) => {
    await applyHook(
      root,
      hook("PreToolUse", {
        tool_name: "Bash",
        tool_use_id: "toolu_bash",
        tool_input: { command: "touch ./probe" },
      }),
      NOW,
    );
    expect((await readSidecar(root, SESSION))?.pending).toBeNull();

    await applyHook(
      root,
      hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "touch ./probe" } }),
      NOW + 1,
    );
    expect((await readSidecar(root, SESSION))?.pending).toEqual({
      kind: "tool",
      toolUseId: "toolu_bash",
      tool: "Bash",
      summary: "touch ./probe",
    });

    await applyHook(root, hook("PostToolUse", { tool_use_id: "toolu_bash" }), NOW + 2);
    expect(await readSidecar(root, SESSION)).toBeNull();
  });
});

test("a file written for another session, a broken file and an oversized file are not read", async () => {
  await withRoot(async (root) => {
    const path = sidecarPath(root, SESSION);
    if (path === null) throw new Error("session id must be valid");

    await writeFile(path, JSON.stringify({ ...started, sessionId: "another-session" }));
    expect(await readSidecar(root, SESSION)).toBeNull();

    await writeFile(path, "{not json");
    expect(await readSidecar(root, SESSION)).toBeNull();

    await writeFile(path, `${JSON.stringify(started)}${" ".repeat(300 * 1024)}`);
    expect(await readSidecar(root, SESSION)).toBeNull();

    expect(await readSidecar(root, "../escape")).toBeNull();
  });
});

test("a saved card is cut to the display limits again when it is read", async () => {
  await withRoot(async (root) => {
    const path = sidecarPath(root, SESSION);
    if (path === null) throw new Error("session id must be valid");
    await writeFile(
      path,
      JSON.stringify({
        ...started,
        pending: {
          kind: "tool",
          toolUseId: "toolu_bash",
          tool: "Bash",
          summary: `line1\nline2${"x".repeat(500)}`,
        },
      }),
    );

    const pending = (await readSidecar(root, SESSION))?.pending;
    expect(pending?.kind === "tool" ? pending.summary : null).toStartWith("line1 line2");
    expect(pending?.kind === "tool" ? [...(pending.summary ?? "")].length : 0).toBe(200);
  });
});

test("writing a wait also removes leftovers older than the lifetime", async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true });
    const stale = join(root, "old-session.json");
    await writeFile(stale, "{}");
    const old = new Date(NOW - SIDECAR_TTL_MS - 1_000);
    await utimes(stale, old, old);

    await applyHook(
      root,
      hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_bash", tool_input: {} }),
      NOW,
    );

    expect(await readdir(root)).toEqual([`${SESSION}.json`]);
  });
});

test("the hook process writes the file and exits 0 even for garbage", async () => {
  await withRoot(async (root) => {
    const script = join(import.meta.dir, "..", "claude-hook.ts");
    const run = async (stdin: string) => {
      const child = Bun.spawn([process.execPath, script, root], {
        stdin: new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out, err, code };
    };

    const ok = await run(
      JSON.stringify(
        hook("PreToolUse", {
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_ask",
          tool_input: { questions },
        }),
      ),
    );
    // stdout の JSON は PreToolUse の判定として解釈される。何も出してはいけない。
    expect(ok).toEqual({ out: "", err: "", code: 0 });
    expect(JSON.parse(await readFile(join(root, `${SESSION}.json`), "utf8")).toolUseId).toBe(
      "toolu_ask",
    );

    expect(await run("not json")).toEqual({ out: "", err: "", code: 0 });
  });
});
