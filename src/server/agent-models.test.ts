import { expect, test } from "bun:test";
import { createAgentModelsClient, parseOpencodeModels, parsePiModels } from "./agent-models";

const model = { provider: "example", id: "beam" };
const table = `provider  model  context  max-out  thinking  images
example   beam   200K     32K      yes       no
example   beam   200K     32K      yes       no
other     beam   200K     32K      no        yes
`;
const service = { url: new URL("http://127.0.0.1:4096"), authorization: "Basic fixture" };

test("Pi candidates keep the provider identity and collapse duplicate rows", () => {
  expect(parsePiModels(table)).toEqual([model, { provider: "other", id: "beam" }]);
  expect(parsePiModels("No models available. Use /login to sign in.")).toEqual([]);
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

test("OpenCode selects a model on a new session without changing shared config", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const client = createAgentModelsClient({
    loadService: async () => service,
    request: async (_service, path, _timeout, body) => {
      calls.push({ path, body });
      return path.startsWith("/api/model")
        ? { data: [{ providerID: "example", id: "beam", enabled: true }] }
        : { data: { id: "ses_fixture" } };
    },
  });
  expect(await client.startArgs("opencode", model, "/new-project")).toEqual([
    "--session",
    "ses_fixture",
  ]);
  expect(calls).toEqual([
    { path: "/api/model?location%5Bdirectory%5D=%2Fnew-project", body: undefined },
    {
      path: "/api/session",
      body: {
        model: { providerID: "example", id: "beam" },
        location: { directory: "/new-project" },
      },
    },
  ]);
});

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
