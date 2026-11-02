import { expect, test } from "bun:test";
import { INITIAL_CONNECTION, connectionAfter, connectionLabel } from "./connection";

test("the first snapshot turns the connection live", () => {
  expect(connectionAfter("snapshot")).toBe("live");
});

test("an error means the browser is reconnecting, not that the app stopped", () => {
  expect(connectionAfter("error")).toBe("reconnecting");
});

test("a stream without state says Herdr itself is unavailable", () => {
  expect(connectionAfter("unavailable")).toBe("unavailable");
});

test("the label spells each state for the header and the settings", () => {
  expect(connectionLabel(INITIAL_CONNECTION)).toBe("接続中");
  expect(connectionLabel("live")).toBe("接続済み");
  expect(connectionLabel("reconnecting")).toBe("再接続中");
  expect(connectionLabel("unavailable")).toBe("Herdr 未接続");
});
