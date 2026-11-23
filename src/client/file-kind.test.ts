import { expect, test } from "bun:test";
import { fileKind } from "./file-kind";

test("source files are code, whatever the extension's case", () => {
  expect(fileKind("app.ts")).toBe("code");
  expect(fileKind("file-tree.tsx")).toBe("code");
  expect(fileKind("APP.TS")).toBe("code");
  expect(fileKind("main.py")).toBe("code");
  expect(fileKind("index.html")).toBe("code");
});

test("config, styles, images and scripts each get their own mark", () => {
  expect(fileKind("package.json")).toBe("data");
  expect(fileKind("tsconfig.json")).toBe("data");
  expect(fileKind("compose.yml")).toBe("data");
  expect(fileKind("tree.css")).toBe("style");
  expect(fileKind("logo.svg")).toBe("image");
  expect(fileKind("hero.png")).toBe("image");
  expect(fileKind("dev.sh")).toBe("shell");
});

test("env files count as config even when they carry a second suffix", () => {
  expect(fileKind(".env")).toBe("data");
  expect(fileKind(".env.local")).toBe("data");
  expect(fileKind(".env.production")).toBe("data");
});

test("lock files are recognised by name, not by their extension", () => {
  expect(fileKind("bun.lock")).toBe("lock");
  expect(fileKind("bun.lockb")).toBe("lock");
  expect(fileKind("package-lock.json")).toBe("lock");
  expect(fileKind("pnpm-lock.yaml")).toBe("lock");
  expect(fileKind("Cargo.lock")).toBe("lock");
  expect(fileKind("yarn.lock")).toBe("lock");
});

test("everything else is a plain document", () => {
  expect(fileKind("notes.local.txt")).toBe("file");
  expect(fileKind("README.md")).toBe("file");
  expect(fileKind(".gitignore")).toBe("file");
  expect(fileKind("LICENSE")).toBe("file");
  expect(fileKind("")).toBe("file");
});
