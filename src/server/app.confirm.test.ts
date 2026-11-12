import { expect, test } from "bun:test";
import type { AppState } from "./herdr/state";
import { FOLDER_TRUST_SCREEN, PI_TRUST_SCREEN } from "../../e2e/fixtures/folder-trust";
import { pane, state, createFakeStore, createTestApp } from "./app.test-helpers";

function folderTrustApp(sendFailure?: Error, agent: "codex" | "pi" = "codex") {
  let screen = agent === "pi" ? PI_TRUST_SCREEN : FOLDER_TRUST_SCREEN;
  let sends = 0;
  let inputs = 0;
  let stops = 0;
  const agentPane = { ...pane, agent, chat: true, agentStatus: "working" as const };
  const agentState: AppState = {
    ...state,
    workspaces: [
      { ...state.workspaces[0]!, tabs: [{ ...state.workspaces[0]!.tabs[0]!, panes: [agentPane] }] },
    ],
  };
  const store = createFakeStore(agentState);
  const { app } = createTestApp({
    store,
    panes: {
      read: async ({ paneId, source }) => ({
        paneId,
        text: source === "detection" ? screen : "terminal output",
        truncated: false,
        revision: 0,
      }),
      confirmFolderTrust: async () => {
        sends += 1;
        if (sendFailure) throw sendFailure;
      },
      send: async () => {
        inputs += 1;
      },
      stop: async () => {
        stops += 1;
      },
    },
  });
  const inspect = async () =>
    (await (await app.request("/api/panes/w1:p1/output")).json()) as {
      interaction: { id: string; submitted: boolean } | null;
    };
  const confirm = (id: unknown) =>
    app.request("/api/panes/w1:p1/confirm-folder-trust", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  return {
    app,
    inspect,
    confirm,
    store,
    setScreen: (text: string) => {
      screen = text;
    },
    counts: () => ({ sends, inputs, stops }),
  };
}

test("output reports a server-issued folder confirmation independently of the conversation", async () => {
  const fixture = folderTrustApp();
  const first = await fixture.inspect();
  expect(first).toMatchObject({
    interaction: {
      kind: "folder-trust",
      agent: "codex",
      directory: "/workspace/acme-dashboard",
      submitted: false,
    },
  });
  expect((await fixture.inspect()).interaction?.id).toBe(first.interaction!.id);
  expect(fixture.counts()).toEqual({ sends: 0, inputs: 0, stops: 0 });
});

test("a valid confirmation succeeds once and does not optimistically clear the prompt", async () => {
  const fixture = folderTrustApp();
  const { interaction } = await fixture.inspect();
  const results = await Promise.all([
    fixture.confirm(interaction!.id),
    fixture.confirm(interaction!.id),
  ]);
  expect(results.map((result) => result.status)).toEqual([200, 409]);
  expect((await fixture.inspect()).interaction?.submitted).toBe(true);
  expect(fixture.counts().sends).toBe(1);
  fixture.setScreen("Codex is ready");
  expect((await fixture.inspect()).interaction).toBeNull();
});

test("a 502 followed by an empty detection frame never issues a second usable approval", async () => {
  const fixture = folderTrustApp(new Error("unknown send outcome"));
  const { interaction } = await fixture.inspect();
  expect((await fixture.confirm(interaction!.id)).status).toBe(502);
  fixture.setScreen("");
  expect((await fixture.inspect()).interaction).toHaveProperty("kind", "terminal");
  expect((await fixture.inspect()).interaction).not.toHaveProperty("id");
  expect((await fixture.confirm(interaction!.id)).status).toBe(409);
  for (const action of ["input", "stop"]) {
    const response = await fixture.app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", submit: true }),
    });
    expect(response.status).toBe(409);
  }
  fixture.setScreen(FOLDER_TRUST_SCREEN);
  expect((await fixture.inspect()).interaction).toMatchObject({
    id: interaction!.id,
    submitted: true,
  });
  expect((await fixture.confirm((await fixture.inspect()).interaction!.id)).status).toBe(409);
  expect(fixture.counts()).toEqual({ sends: 1, inputs: 0, stops: 0 });
});

test("confirmation rejects malformed, forged and stale identifiers without sending keys", async () => {
  const fixture = folderTrustApp();
  for (const id of [null, false, 0, "", [], {}])
    expect((await fixture.confirm(id)).status).toBe(400);
  expect((await fixture.confirm("forged")).status).toBe(409);
  const { interaction } = await fixture.inspect();
  fixture.setScreen(FOLDER_TRUST_SCREEN.replace("acme-dashboard", "other-project"));
  expect((await fixture.confirm(interaction!.id)).status).toBe(409);
  expect(fixture.counts().sends).toBe(0);
});

test("approval refreshes agent identity and rejects a pane whose agent no longer has a trust prompt", async () => {
  const fixture = folderTrustApp();
  const { interaction } = await fixture.inspect();
  fixture.store.push(state, true);
  expect((await fixture.confirm(interaction!.id)).status).toBe(409);
  expect(fixture.counts().sends).toBe(0);
});

test("a Pi project trust prompt is reported, guarded and answered like Codex", async () => {
  const fixture = folderTrustApp(undefined, "pi");
  const first = await fixture.inspect();
  expect(first.interaction).toMatchObject({
    kind: "folder-trust",
    agent: "pi",
    directory: "/workspace/acme-dashboard",
    submitted: false,
  });
  for (const action of ["input", "stop"]) {
    const response = await fixture.app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", submit: true }),
    });
    expect(response.status).toBe(409);
  }
  expect((await fixture.confirm(first.interaction!.id)).status).toBe(200);
  expect((await fixture.inspect()).interaction).toMatchObject({ submitted: true });
  fixture.setScreen("› Ask pi to do anything\n");
  expect((await fixture.inspect()).interaction).toBeNull();
  expect(fixture.counts()).toEqual({ sends: 1, inputs: 0, stops: 0 });
});

test("a Pi conversation that only mentions the dialog footer still accepts input", async () => {
  const fixture = folderTrustApp(undefined, "pi");
  fixture.setScreen("› Ask pi to do anything\n\n↑↓ navigate  enter select  escape/ctrl+c cancel\n");
  expect((await fixture.inspect()).interaction).toBeNull();
  const response = await fixture.app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", submit: true }),
  });
  expect(response.status).toBe(200);
  expect(fixture.counts()).toEqual({ sends: 0, inputs: 1, stops: 0 });
});

test("message and stop requests cannot answer or cancel the pending trust screen", async () => {
  const fixture = folderTrustApp();
  for (const action of ["input", "stop"]) {
    const response = await fixture.app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", submit: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "confirmation_pending" });
  }
  expect(fixture.counts()).toEqual({ sends: 0, inputs: 0, stops: 0 });
});

test("confirmation returns 404 for absent panes and 502 if authoritative state is unavailable", async () => {
  const fixture = folderTrustApp();
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "old" }),
  };
  expect((await fixture.app.request("/api/panes/w1:p9/confirm-folder-trust", request)).status).toBe(
    404,
  );
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("offline"),
  });
  expect((await app.request("/api/panes/w1:p1/confirm-folder-trust", request)).status).toBe(502);
});

test.each(["application/json", "Application/JSON; Charset=utf-8"])(
  "folder confirmation accepts the JSON media type %s",
  async (contentType) => {
    const fixture = folderTrustApp();
    const { interaction } = await fixture.inspect();
    const response = await fixture.app.request("/api/panes/w1:p1/confirm-folder-trust", {
      method: "POST",
      headers: { "content-type": contentType },
      body: JSON.stringify({ id: interaction!.id }),
    });
    expect(response.status).toBe(200);
  },
);
