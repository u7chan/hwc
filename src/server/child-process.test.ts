import { expect, test } from "bun:test";
import { childEnv, readCappedStdout } from "./child-process";

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function withEnv(vars: Record<string, string>, body: () => void): void {
  const previous = Object.entries(vars).map(([key]) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    body();
  } finally {
    for (const [key, value] of previous) restore(key, value);
  }
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("the child environment drops the Herdr identity of the calling process", () => {
  withEnv({ HERDR_PANE_ID: "pane", HERDR_SOCKET: "/tmp/herdr.sock", HWC_KEPT: "kept" }, () => {
    const env = childEnv();
    expect(env.HERDR_PANE_ID).toBeUndefined();
    expect(env.HERDR_SOCKET).toBeUndefined();
    expect(env.HWC_KEPT).toBe("kept");
  });
});

test("extra keys are dropped and extra values are set on request", () => {
  withEnv({ CODEX_THREAD_ID: "thread", NO_COLOR: "0" }, () => {
    const env = childEnv({ omit: ["CODEX_THREAD_ID"], set: { NO_COLOR: "1" } });
    expect(env.CODEX_THREAD_ID).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
  });
});

test("the child environment is a copy and leaves process.env alone", () => {
  withEnv({ HWC_ORIGINAL: "original" }, () => {
    const env = childEnv({ set: { HWC_ORIGINAL: "changed", HWC_ADDED: "added" } });
    expect(env.HWC_ORIGINAL).toBe("changed");
    expect(env.HWC_ADDED).toBe("added");
    expect(process.env.HWC_ORIGINAL).toBe("original");
    expect(process.env.HWC_ADDED).toBeUndefined();
  });
});

test("the capped reader decodes the whole output and allows exactly the limit", async () => {
  const encoded = new TextEncoder().encode("あ");
  const text = await readCappedStdout(streamOf([encoded.subarray(0, 1), encoded.subarray(1)]), {
    maxBytes: encoded.byteLength,
    tooLarge: "output is too large",
  });
  expect(text).toBe("あ");
});

test("the capped reader throws the message of the caller once the output passes the limit", async () => {
  await expect(
    readCappedStdout(streamOf([new Uint8Array(4)]), {
      maxBytes: 3,
      tooLarge: "output is too large",
    }),
  ).rejects.toThrow("output is too large");
});
