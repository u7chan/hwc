import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPiModelWindows, parsePiModelWindows } from "./pi-models";

test("the RPC model response preserves exact windows and provider identity", () => {
  const response = JSON.stringify({
    type: "response",
    command: "get_available_models",
    success: true,
    data: {
      models: [
        { provider: "example", id: "beam", contextWindow: 256_123 },
        { provider: "other", id: "beam", contextWindow: 500_000 },
        { provider: "example", id: "invalid", contextWindow: 0 },
        { provider: "example", id: "missing" },
      ],
    },
  });
  expect(parsePiModelWindows(`{"type":"event"}\n${response}\n`)).toEqual([
    { provider: "example", id: "beam", window: 256_123 },
    { provider: "other", id: "beam", window: 500_000 },
  ]);
});

test("an unavailable or malformed RPC response is not a catalog", () => {
  expect(() => parsePiModelWindows('{"command":"get_available_models","success":false}')).toThrow();
  expect(() => parsePiModelWindows("not json")).toThrow();
  expect(() => parsePiModelWindows('{"type":"event"}')).toThrow();
});

test("model discovery is offline, ephemeral, and does not inherit Herdr identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "hwc-pi-models-"));
  const oldPath = process.env.PATH;
  const oldPane = process.env.HERDR_PANE_ID;
  try {
    const bin = join(root, "bin");
    const agent = join(root, "agent");
    await mkdir(bin);
    await mkdir(agent);
    await writeFile(
      join(bin, "pi"),
      `#!/bin/sh
if [ "$*" != "--offline --mode rpc --no-session --no-extensions" ]; then exit 2; fi
if [ -n "\${HERDR_PANE_ID+x}" ] || [ "$PI_CODING_AGENT_DIR" != "$PWD" ]; then exit 3; fi
IFS= read -r request
if [ "$request" != '{"type":"get_available_models"}' ]; then exit 4; fi
printf '%s\\n' '{"command":"get_available_models","success":true,"data":{"models":[{"provider":"example","id":"beam","contextWindow":500000}]}}'
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    process.env.HERDR_PANE_ID = "must-not-leak";
    expect(await loadPiModelWindows(agent)).toEqual([
      { provider: "example", id: "beam", window: 500_000 },
    ]);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = oldPane;
    await rm(root, { recursive: true, force: true });
  }
});
