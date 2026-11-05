import { expect, test } from "bun:test";
import { createAgentModelsClient, parseOpencodeModels, parsePiModels } from "./agent-models";
import type { CodexReader } from "./codex";

const model = { provider: "example", id: "beam" };
const namespacedModel = {
  provider: "cloudflare-workers-ai",
  id: "@cf/meta/llama-3.2-3b-instruct",
};
const table = `provider  model  context  max-out  thinking  images
example   beam   200K     32K      yes       no
example   beam   200K     32K      yes       no
other     beam   200K     32K      no        yes
`;
const service = { url: new URL("http://127.0.0.1:4096"), authorization: "Basic fixture" };

function codexReader(options: { provider?: unknown; pages?: unknown[]; config?: unknown } = {}) {
  const calls: {
    method: string;
    params: Record<string, unknown>;
    directory: string | undefined;
  }[] = [];
  const read: CodexReader = async (directory, run) => {
    let page = 0;
    return run(async (method, params) => {
      calls.push({ method, params, directory });
      if (method === "config/read")
        return options.config ?? { config: { model_provider: options.provider } };
      if (method === "model/list")
        return (
          options.pages?.[page++] ?? { data: [{ id: "picker-id", model: "beam", hidden: false }] }
        );
      throw new Error("Model selection must not start a thread or change config");
    });
  };
  return { read, calls };
}

test("Codex candidates use API model slugs and the effective provider, not picker ids", async () => {
  const { read, calls } = codexReader({
    provider: "example",
    pages: [
      {
        data: [
          { id: "picker-one", model: "beam", hidden: false },
          { id: "picker-two", model: "beam", hidden: false },
          { model: "hidden", hidden: true },
          { model: "--help", hidden: false },
        ],
        nextCursor: "more",
      },
      { data: [{ model: "beam-mini", hidden: false }], nextCursor: null },
    ],
  });
  const client = createAgentModelsClient({ codex: read });
  expect(await client.list("codex", "/project")).toEqual([
    model,
    { provider: "example", id: "beam-mini" },
  ]);
  expect(calls.map((call) => call.method)).toEqual(["config/read", "model/list", "model/list"]);
  expect(calls.every((call) => call.directory === "/project")).toBe(true);
  expect(calls[0]?.params).toEqual({ cwd: "/project", includeLayers: false });
  expect(calls[2]?.params.cursor).toBe("more");
});

test("Codex uses OpenAI when config leaves the provider unset", async () => {
  const { read } = codexReader();
  expect(await createAgentModelsClient({ codex: read }).list("codex", "/project")).toEqual([
    { provider: "openai", id: "beam" },
  ]);
});

test("an empty Codex model catalog stays empty", async () => {
  const { read } = codexReader({ pages: [{ data: [], nextCursor: null }] });
  expect(await createAgentModelsClient({ codex: read }).list("codex", "/project")).toEqual([]);
});

test("Codex starts only the selected model in the new pane's effective directory", async () => {
  const { read, calls } = codexReader({ provider: "example" });
  const client = createAgentModelsClient({ codex: read });
  expect(await client.startArgs("codex", model, "/new-project")).toEqual(["--model", "beam"]);
  expect(calls.every((call) => call.directory === "/new-project")).toBe(true);
  await expect(
    client.startArgs("codex", { ...model, provider: "other" }, "/new-project"),
  ).rejects.toThrow();
  await expect(
    client.startArgs("codex", { ...model, id: "bea" }, "/new-project"),
  ).rejects.toThrow();
});

test.each([{}, { data: null }, { data: [], nextCursor: 42 }])(
  "malformed Codex catalogs are unavailable: %j",
  async (page) => {
    const { read } = codexReader({ pages: [page] });
    await expect(
      createAgentModelsClient({ codex: read }).list("codex", "/project"),
    ).rejects.toThrow();
  },
);

test("Codex rejects a missing config instead of using an unrelated provider", async () => {
  const { read } = codexReader({ config: {} });
  await expect(
    createAgentModelsClient({ codex: read }).list("codex", "/project"),
  ).rejects.toThrow();
});

test("Codex catalog pagination must advance", async () => {
  const page = { data: [], nextCursor: "same" };
  const { read } = codexReader({ pages: [page, page] });
  await expect(
    createAgentModelsClient({ codex: read }).list("codex", "/project"),
  ).rejects.toThrow();
});

test("excessive Codex catalog pagination fails instead of returning a partial selection", async () => {
  const { read } = codexReader({
    pages: Array.from({ length: 11 }, (_, i) => ({ data: [], nextCursor: `page${i}` })),
  });
  await expect(createAgentModelsClient({ codex: read }).list("codex", "/project")).rejects.toThrow(
    "too large",
  );
});

test("Pi candidates keep the provider identity and collapse duplicate rows", () => {
  expect(parsePiModels(table)).toEqual([model, { provider: "other", id: "beam" }]);
  expect(parsePiModels("No models available. Use /login to sign in.")).toEqual([]);
});

test("Pi candidates preserve namespaced model IDs starting with @", () => {
  expect(parsePiModels(table.replaceAll("beam", namespacedModel.id))).toEqual([
    { provider: "example", id: namespacedModel.id },
    { provider: "other", id: namespacedModel.id },
  ]);
});

test("unrecognized or malformed Pi output is unavailable, not a fabricated model", () => {
  expect(() => parsePiModels("Failed to load models")).toThrow();
  expect(() => parsePiModels(`${table}unexpected output`)).toThrow();
  expect(() => parsePiModels(table.replace("example   beam", "example   --help"))).toThrow();
});

test("OpenCode candidates include only enabled models and keep provider identity", () => {
  expect(
    parseOpencodeModels({
      data: [
        { providerID: "example", id: "beam", enabled: true },
        { providerID: "example", id: "hidden", enabled: false },
        { providerID: "example", id: "unknown" },
        { providerID: "other", id: "beam", enabled: true },
        { providerID: "other", id: "beam", enabled: true },
        { providerID: "example", id: "--help", enabled: true },
        null,
      ],
    }),
  ).toEqual([model, { provider: "other", id: "beam" }]);
  expect(parseOpencodeModels({ data: [] })).toEqual([]);
  expect(() => parseOpencodeModels({})).toThrow();
});

test("enabled Cloudflare Workers AI models stay in the OpenCode candidates", () => {
  expect(
    parseOpencodeModels({
      data: [
        {
          providerID: namespacedModel.provider,
          id: namespacedModel.id,
          enabled: true,
        },
      ],
    }),
  ).toEqual([namespacedModel]);
});

test("Pi startup uses the new pane's directory and a provider-qualified --model", async () => {
  const directories: string[] = [];
  const client = createAgentModelsClient({
    piModels: async (directory) => {
      directories.push(directory);
      return table;
    },
    loadService: async () => {
      throw new Error("Pi must not contact OpenCode");
    },
  });
  expect(await client.startArgs("pi", model, "/new-project")).toEqual(["--model", "example/beam"]);
  expect(directories).toEqual(["/new-project"]);
});

test("an unavailable Pi model is rejected instead of relying on CLI fuzzy matching", async () => {
  const client = createAgentModelsClient({ piModels: async () => table });
  await expect(client.startArgs("pi", { ...model, id: "bea" }, "/project")).rejects.toThrow();
});

test.each([model, namespacedModel])(
  "OpenCode starts %j on a new session without changing shared config",
  async (selected) => {
    const calls: { path: string; body: unknown }[] = [];
    const client = createAgentModelsClient({
      loadService: async () => service,
      request: async (_service, path, _timeout, body) => {
        calls.push({ path, body });
        return path.startsWith("/api/model")
          ? { data: [{ providerID: selected.provider, id: selected.id, enabled: true }] }
          : { data: { id: "ses_fixture" } };
      },
    });
    expect(await client.startArgs("opencode", selected, "/new-project")).toEqual([
      "--session",
      "ses_fixture",
    ]);
    expect(calls).toEqual([
      { path: "/api/model?location%5Bdirectory%5D=%2Fnew-project", body: undefined },
      {
        path: "/api/session",
        body: {
          model: { providerID: selected.provider, id: selected.id },
          location: { directory: "/new-project" },
        },
      },
    ]);
  },
);

test("an unavailable OpenCode model does not create a session", async () => {
  const paths: string[] = [];
  const client = createAgentModelsClient({
    loadService: async () => service,
    request: async (_service, path) => {
      paths.push(path);
      return { data: [] };
    },
  });
  await expect(client.startArgs("opencode", model, "/project")).rejects.toThrow();
  expect(paths).toHaveLength(1);
  expect(paths[0]).toStartWith("/api/model?");
});

test.each([{}, { data: {} }, { data: { id: "--help" } }])(
  "a malformed new session response is rejected: %j",
  async (reply) => {
    const client = createAgentModelsClient({
      loadService: async () => service,
      request: async (_service, path) =>
        path.startsWith("/api/model")
          ? { data: [{ providerID: "example", id: "beam", enabled: true }] }
          : reply,
    });
    await expect(client.startArgs("opencode", model, "/project")).rejects.toThrow();
  },
);

test("the OpenCode transport reads models and posts the selected model to session.create", async () => {
  const calls: { method: string; path: string; authorization: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.json() : null,
      });
      return Response.json(
        path === "/api/model"
          ? { data: [{ providerID: "example", id: "beam", enabled: true }] }
          : { data: { id: "ses_fixture" } },
      );
    },
  });
  try {
    const client = createAgentModelsClient({
      loadService: async () => ({ ...service, url: server.url }),
    });
    expect(await client.startArgs("opencode", model, "/project")).toEqual([
      "--session",
      "ses_fixture",
    ]);
    expect(calls).toEqual([
      { method: "GET", path: "/api/model", authorization: service.authorization, body: null },
      {
        method: "POST",
        path: "/api/session",
        authorization: service.authorization,
        body: { model: { providerID: "example", id: "beam" }, location: { directory: "/project" } },
      },
    ]);
  } finally {
    server.stop(true);
  }
});
