import { expect, test } from "bun:test";
import { asRecord, nonEmptyText } from "./json";

test("returns a plain object as is", () => {
  const value = { a: 1, b: "x" };
  expect(asRecord(value)).toBe(value);
});

test("rejects null and arrays", () => {
  expect(asRecord(null)).toBeNull();
  expect(asRecord([])).toBeNull();
  expect(asRecord([{ a: 1 }])).toBeNull();
});

test("rejects primitives and functions", () => {
  expect(asRecord("text")).toBeNull();
  expect(asRecord("")).toBeNull();
  expect(asRecord(0)).toBeNull();
  expect(asRecord(1.5)).toBeNull();
  expect(asRecord(true)).toBeNull();
  expect(asRecord(undefined)).toBeNull();
  expect(asRecord(10n)).toBeNull();
  expect(asRecord(Symbol("s"))).toBeNull();
  expect(asRecord(() => 1)).toBeNull();
});

test("accepts objects without a prototype and non-plain objects", () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare.a = 1;
  expect(asRecord(bare)).toBe(bare);

  expect(asRecord(new Date(0))).not.toBeNull();
});

test("returns only a non-empty string as text", () => {
  expect(nonEmptyText("x")).toBe("x");
  expect(nonEmptyText(" ")).toBe(" ");
  expect(nonEmptyText("")).toBeNull();
  expect(nonEmptyText(null)).toBeNull();
  expect(nonEmptyText(undefined)).toBeNull();
  expect(nonEmptyText(0)).toBeNull();
  expect(nonEmptyText(false)).toBeNull();
  expect(nonEmptyText([])).toBeNull();
  expect(nonEmptyText({})).toBeNull();
});
