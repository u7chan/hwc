import { expect, test } from "bun:test";
import type { Template } from "../shared/templates";
import { MAX_TEMPLATES } from "../shared/templates";
import { createTestApp } from "./app.test-helpers";
import { createTemplatesStore } from "./templates";

const sample: Template[] = [
  { id: "t1", title: "続けて", body: "続けてください。" },
  { id: "t2", title: "テストを流す", body: "テストを流してください。" },
];

function createFakeTemplates(initial: Template[] = []) {
  const store = createTemplatesStore({ read: () => null, write: () => {} });
  if (initial.length > 0) store.save(initial);
  return store;
}

function putJson(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("GET /api/templates returns the saved list", async () => {
  const { app } = createTestApp({ templates: createFakeTemplates(sample) });

  const response = await app.request("/api/templates");

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ templates: sample });
});

test("GET /api/templates returns an empty list before anything is saved", async () => {
  const { app } = createTestApp({ templates: createFakeTemplates() });
  expect(await (await app.request("/api/templates")).json()).toEqual({ templates: [] });
});

test("PUT /api/templates saves the whole list and returns the snapshot", async () => {
  const templates = createFakeTemplates();
  const { app } = createTestApp({ templates });

  const response = await app.request(
    "/api/templates",
    putJson({ templates: [{ id: "t1", title: "  続けて  ", body: "\n続けてください。\n" }] }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    templates: [{ id: "t1", title: "続けて", body: "続けてください。" }],
  });
  expect(templates.get()).toEqual([{ id: "t1", title: "続けて", body: "続けてください。" }]);
});

test("PUT /api/templates accepts an empty list", async () => {
  const templates = createFakeTemplates(sample);
  const { app } = createTestApp({ templates });

  const response = await app.request("/api/templates", putJson({ templates: [] }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ templates: [] });
  expect(templates.get()).toEqual([]);
});

test("PUT /api/templates refuses a broken list and keeps the saved one", async () => {
  const templates = createFakeTemplates(sample);
  const { app } = createTestApp({ templates });

  const bodies: unknown[] = [
    { templates: [{ id: "t1", title: "", body: "本文" }] },
    {
      templates: [
        { id: "t1", title: "名前", body: "本文" },
        { id: "t1", title: "重複", body: "本文" },
      ],
    },
    { templates: "not an array" },
    { templates: null },
    {},
    null,
  ];
  for (const body of bodies) {
    const response = await app.request("/api/templates", putJson(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  }
  expect(templates.get()).toEqual(sample);
});

test("PUT /api/templates refuses more templates than the limit", async () => {
  const { app } = createTestApp({ templates: createFakeTemplates() });
  const many = Array.from({ length: MAX_TEMPLATES + 1 }, (_, index) => ({
    id: `t${index}`,
    title: `名前 ${index}`,
    body: "本文",
  }));

  const response = await app.request("/api/templates", putJson({ templates: many }));

  expect(response.status).toBe(400);
});

test("PUT /api/templates requires JSON", async () => {
  const { app } = createTestApp({ templates: createFakeTemplates() });

  const response = await app.request("/api/templates", { method: "PUT", body: "{}" });

  expect(response.status).toBe(415);
});

test("PUT /api/templates keeps the previous list when the write fails", async () => {
  let fail = false;
  const templates = createTemplatesStore({
    read: () => null,
    write: () => {
      if (fail) throw new Error("disk full");
    },
  });
  templates.save(sample);
  fail = true;
  const { app } = createTestApp({ templates });

  const response = await app.request(
    "/api/templates",
    putJson({ templates: [{ id: "t3", title: "別の定型文", body: "本文" }] }),
  );

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "settings_unavailable" });
  expect(templates.get()).toEqual(sample);
});
