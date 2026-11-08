import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments";
import type { ChatSnapshot } from "./chat/contract";
import {
  attachMessageFiles,
  collectMessageFiles,
  imagePathCandidates,
  resolveMessageFile,
} from "./message-files";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hwc-message-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function write(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

test("collects paths from prose, inline code, links and images", () => {
  const text = [
    "モックは `.artifacts/mock.png` に置きました。",
    "元の画像は docs/before.jpg です。",
    "![比較](docs/after.webp)",
    "詳細は [こちら](docs/preview.jpeg) を見てください。",
  ].join("\n");

  expect(imagePathCandidates(text)).toEqual([
    ".artifacts/mock.png",
    "docs/before.jpg",
    "docs/after.webp",
    "docs/preview.jpeg",
  ]);
});

test("finds a path in inline code with no spaces around it", () => {
  expect(
    imagePathCandidates("空状態の確認に使った画面です。`docs/preview/app-icon.png` に置きました。"),
  ).toEqual(["docs/preview/app-icon.png"]);
});

test("drops a sentence period or a Japanese particle after the extension", () => {
  expect(imagePathCandidates("The mock is at docs/mock.png.")).toEqual(["docs/mock.png"]);
  expect(imagePathCandidates("スクショはdocs/mock.pngに置きました。")).toEqual(["docs/mock.png"]);
  // 全角コロンの後ろでも拾う。
  expect(imagePathCandidates("モック：docs/mock.png")).toEqual(["docs/mock.png"]);
  // 別の拡張子が続く名前は画像として扱わない。
  expect(imagePathCandidates("docs/mock.png.bak")).toEqual([]);
  // 日本語のファイル名はそのまま残す。
  expect(imagePathCandidates("モック.png")).toEqual(["モック.png"]);
});

test("does not look inside fenced code", () => {
  expect(imagePathCandidates("```sh\nopen docs/mock.png\n```\n")).toEqual([]);
  expect(imagePathCandidates("~~~\n![x](a.png)\n~~~\n`b.png`")).toEqual(["b.png"]);
});

test("ignores paths that are not local images", () => {
  expect(imagePathCandidates("https://example.com/a.png")).toEqual([]);
  expect(imagePathCandidates("[remote](https://example.com/a.png)")).toEqual([]);
  expect(imagePathCandidates("data:image/png;base64,AAAA")).toEqual([]);
  expect(imagePathCandidates("docs/README.md と src/app.ts")).toEqual([]);
});

test("keeps each path once and stops at the candidate limit", () => {
  expect(imagePathCandidates("a.png `a.png` [x](a.png)")).toEqual(["a.png"]);

  const many = Array.from({ length: 30 }, (_, index) => `f${index}.png`).join(" ");
  expect(imagePathCandidates(many)).toHaveLength(20);
});

test("finds an existing image below the root", async () => {
  await write("docs/mock.png", png);

  const files = await collectMessageFiles("![モック](docs/mock.png)", root);

  expect(files.map((file) => file.name)).toEqual(["docs/mock.png"]);
  expect(files[0]?.version).toMatch(/^\d+-\d+$/);
});

test("accepts an absolute path only inside the root", async () => {
  const inside = await write("docs/mock.png", png);
  const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
  const outsidePath = join(outside, "secret.png");
  await writeFile(outsidePath, png);

  try {
    expect((await collectMessageFiles(`\`${inside}\``, root)).map((file) => file.name)).toEqual([
      "docs/mock.png",
    ]);
    expect(await collectMessageFiles(`\`${outsidePath}\``, root)).toEqual([]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("refuses traversal and a symlink that leaves the root", async () => {
  const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
  const outsidePath = join(outside, "secret.png");
  await writeFile(outsidePath, png);
  await symlink(outsidePath, join(root, "link.png"));

  try {
    const traversal = join("..", basename(outside), "secret.png");
    expect(await collectMessageFiles(`\`${traversal}\``, root)).toEqual([]);
    expect(await collectMessageFiles("link.png", root)).toEqual([]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("only serves a regular file with an allowed image extension", async () => {
  await write("docs/note.txt", png);
  await write("docs/empty.png", new Uint8Array());
  await mkdir(join(root, "docs/folder.png"), { recursive: true });

  expect(await resolveMessageFile({ root, path: "docs/note.txt" })).toBeNull();
  expect(await resolveMessageFile({ root, path: "docs/empty.png" })).toBeNull();
  expect(await resolveMessageFile({ root, path: "docs/folder.png" })).toBeNull();
  expect(await resolveMessageFile({ root, path: "../" })).toBeNull();
  expect(await resolveMessageFile({ root, path: "" })).toBeNull();
});

test("refuses an image over the size limit", async () => {
  await write("big.png", new Uint8Array(MAX_ATTACHMENT_BYTES + 1));

  expect(await resolveMessageFile({ root, path: "big.png" })).toBeNull();
});

test("changes the version when the file changes", async () => {
  await write("mock.png", png);
  const first = await collectMessageFiles("mock.png", root);

  await write("mock.png", new Uint8Array([...png, 0]));
  const second = await collectMessageFiles("mock.png", root);

  expect(first[0]?.version).not.toBe(second[0]?.version);
});

const snapshot: ChatSnapshot = {
  etag: "base",
  messages: [
    { id: "u1", role: "user", text: "docs/mock.png", at: 1 },
    { id: "a1", role: "agent", text: "`docs/mock.png` を見てください。", at: 2 },
    { id: "e1", role: "error", text: "docs/mock.png", at: 3 },
  ],
  model: null,
  effort: null,
  truncated: false,
  context: null,
  compaction: null,
};

test("attaches files to agent messages only and folds the versions into the etag", async () => {
  await write("docs/mock.png", png);

  const attached = await attachMessageFiles(snapshot, root);

  expect(attached.messages[1]?.files?.map((file) => file.name)).toEqual(["docs/mock.png"]);
  expect(attached.messages[0]?.files).toBeUndefined();
  expect(attached.messages[2]?.files).toBeUndefined();
  expect(attached.etag).not.toBe(snapshot.etag);
});

test("reuses the same snapshot when there is nothing to attach", async () => {
  expect(await attachMessageFiles(snapshot, null)).toBe(snapshot);

  const plain = {
    ...snapshot,
    messages: [{ ...snapshot.messages[1]!, text: "追加の修正はありません。" }],
  };
  expect(await attachMessageFiles(plain, root)).toBe(plain);
});

test("keeps the etag stable while the image does not change", async () => {
  await write("docs/mock.png", png);

  const first = await attachMessageFiles(snapshot, root);
  const second = await attachMessageFiles(snapshot, root);

  expect(second.etag).toBe(first.etag);
});
