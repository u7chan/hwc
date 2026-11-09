import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments";
import type { ChatSnapshot } from "./chat/contract";
import {
  attachMessageFiles,
  collectMessageFiles,
  defaultPreviewRoots,
  messagePathCandidates,
  resolveMessageFile,
  resolvePreviewFile,
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

  expect(messagePathCandidates(text)).toEqual([
    ".artifacts/mock.png",
    "docs/before.jpg",
    "docs/after.webp",
    "docs/preview.jpeg",
  ]);
});

test("finds a path in inline code with no spaces around it", () => {
  expect(
    messagePathCandidates(
      "空状態の確認に使った画面です。`docs/preview/app-icon.png` に置きました。",
    ),
  ).toEqual(["docs/preview/app-icon.png"]);
});

test("drops a sentence period or a Japanese particle after the extension", () => {
  expect(messagePathCandidates("The mock is at docs/mock.png.")).toEqual(["docs/mock.png"]);
  expect(messagePathCandidates("スクショはdocs/mock.pngに置きました。")).toEqual(["docs/mock.png"]);
  // 全角コロンの後ろでも拾う。
  expect(messagePathCandidates("モック：docs/mock.png")).toEqual(["docs/mock.png"]);
  // 別の拡張子が続く名前は画像として扱わない。
  expect(messagePathCandidates("docs/mock.png.bak")).toEqual([]);
  // 日本語のファイル名はそのまま残す。
  expect(messagePathCandidates("モック.png")).toEqual(["モック.png"]);
});

test("splits paths joined by punctuation in one token", () => {
  // 全角の区切りで並んだ 2 枚を別々に拾う。区切りの分割が効かないと 1 件にもならない。
  expect(messagePathCandidates("docs/a.png、docs/b.png")).toEqual(["docs/a.png", "docs/b.png"]);
  expect(messagePathCandidates("（docs/a.png）")).toEqual(["docs/a.png"]);
});

test("does not look inside fenced code", () => {
  expect(messagePathCandidates("```sh\nopen docs/mock.png\n```\n")).toEqual([]);
  expect(messagePathCandidates("~~~\n![x](a.png)\n~~~\n`b.png`")).toEqual(["b.png"]);
});

test("ignores paths that are not local images", () => {
  expect(messagePathCandidates("https://example.com/a.png")).toEqual([]);
  expect(messagePathCandidates("[remote](https://example.com/a.png)")).toEqual([]);
  expect(messagePathCandidates("data:image/png;base64,AAAA")).toEqual([]);
  expect(messagePathCandidates("docs/README.md と src/app.ts")).toEqual([]);
});

test("keeps each path once and stops at the candidate limit", () => {
  expect(messagePathCandidates("a.png `a.png` [x](a.png)")).toEqual(["a.png"]);

  const many = Array.from({ length: 30 }, (_, index) => `f${index}.png`).join(" ");
  expect(messagePathCandidates(many)).toHaveLength(20);
});

test("finds an existing image below the root", async () => {
  await write("docs/mock.png", png);

  const files = await collectMessageFiles("![モック](docs/mock.png)", root);

  expect(files.map((file) => ({ name: file.name, kind: file.kind }))).toEqual([
    { name: "docs/mock.png", kind: "image" },
  ]);
  expect(files[0]?.version).toMatch(/^\d+-\d+$/);
});

test("finds an HTML file below the root and marks it for preview", async () => {
  await write("docs/preview/index.html", new TextEncoder().encode("<!doctype html>"));

  const files = await collectMessageFiles("モックは `docs/preview/index.html` です。", root);

  expect(files).toHaveLength(1);
  expect(files[0]?.name).toBe("docs/preview/index.html");
  expect(files[0]?.kind).toBe("html");
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
  await write("docs/mock.html", new TextEncoder().encode("<!doctype html>"));
  await mkdir(join(root, "docs/folder.png"), { recursive: true });

  expect(await resolveMessageFile({ root, path: "docs/note.txt" })).toBeNull();
  expect(await resolveMessageFile({ root, path: "docs/empty.png" })).toBeNull();
  expect(await resolveMessageFile({ root, path: "docs/folder.png" })).toBeNull();
  // HTML はプレビューの経路が受ける。画像の配信では返さない。
  expect(await resolveMessageFile({ root, path: "docs/mock.html" })).toBeNull();
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

test("serves the HTML and the files it references from the same root", async () => {
  await write("preview/index.html", new TextEncoder().encode("<!doctype html>"));
  await write("preview/app.css", new TextEncoder().encode("body{}"));
  await write("preview/app.js", new TextEncoder().encode("export {}"));
  await write("preview/data.json", new TextEncoder().encode("{}"));
  // svg はモックの装飾に使う。単体で開いても CSP の sandbox が効く。
  await write("preview/logo.svg", new TextEncoder().encode("<svg/>"));
  await write("preview/notes.txt", new TextEncoder().encode("text"));

  expect((await resolvePreviewFile({ root, path: "preview/index.html" }))?.contentType).toBe(
    "text/html; charset=utf-8",
  );
  expect((await resolvePreviewFile({ root, path: "preview/app.css" }))?.contentType).toBe(
    "text/css; charset=utf-8",
  );
  expect((await resolvePreviewFile({ root, path: "preview/app.js" }))?.contentType).toBe(
    "text/javascript; charset=utf-8",
  );
  expect((await resolvePreviewFile({ root, path: "preview/data.json" }))?.contentType).toBe(
    "application/json; charset=utf-8",
  );
  expect((await resolvePreviewFile({ root, path: "preview/logo.svg" }))?.contentType).toBe(
    "image/svg+xml",
  );
  // 一覧に無い形式は配信しない。
  expect(await resolvePreviewFile({ root, path: "preview/notes.txt" })).toBeNull();
});

test("serves an absolute path only from the root it was given", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  const page = join(extra, "mock.html");
  await writeFile(page, "<!doctype html>");

  try {
    expect(await resolvePreviewFile({ root, path: page })).toBeNull();
    const found = await resolvePreviewFile({ root: extra, path: page });
    expect(found?.name).toBe("mock.html");
    expect(found?.path).toBe(page);
    // 相対パスも同じ根から読める。
    expect((await resolvePreviewFile({ root: extra, path: "mock.html" }))?.name).toBe("mock.html");
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("refuses traversal and unknown extensions in the preview route", async () => {
  await write("index.html", new TextEncoder().encode("<!doctype html>"));
  const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
  const outsidePath = join(outside, "secret.html");
  await writeFile(outsidePath, "<!doctype html>");
  await symlink(outsidePath, join(root, "link.html"));

  try {
    expect(
      await resolvePreviewFile({ root, path: `../${basename(outside)}/secret.html` }),
    ).toBeNull();
    expect(await resolvePreviewFile({ root, path: "link.html" })).toBeNull();
    expect(await resolvePreviewFile({ root, path: "" })).toBeNull();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("reads the extra preview roots from the environment", () => {
  expect(defaultPreviewRoots({})).toEqual([]);
  expect(defaultPreviewRoots({ HWC_PREVIEW_ROOTS: "" })).toEqual([]);
  // 相対パスは作業ディレクトリに依存するので採らない。
  expect(defaultPreviewRoots({ HWC_PREVIEW_ROOTS: "relative:/tmp/mock" })).toEqual(["/tmp/mock"]);
  expect(defaultPreviewRoots({ HWC_PREVIEW_ROOTS: "/tmp/a:/tmp/b" })).toEqual(["/tmp/a", "/tmp/b"]);
});

test("finds the HTML in an extra root only when the root is passed", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  const page = join(extra, "mock.html");
  await writeFile(page, "<!doctype html>");

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: `モックは \`${page}\` です。`, at: 1 }],
  };

  try {
    // 追加根を渡さなければ、チェックアウトの外は検出しない。
    expect((await attachMessageFiles(chat, root)).messages[0]?.files).toBeUndefined();

    const attached = await attachMessageFiles(chat, root, [extra]);
    expect(attached.messages[0]?.files).toMatchObject([
      { name: "mock.html", kind: "html", root: 1 },
    ]);
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("keeps the checkout first for an image that only exists in an extra root", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  await writeFile(join(extra, "photo.png"), png);

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: "`photo.png` と `photo.png`", at: 1 }],
  };

  try {
    // 画像は /files がチェックアウトだけを根にする。追加根から拾うと配信先が無い。
    expect((await attachMessageFiles(chat, root, [extra])).messages[0]?.files).toBeUndefined();

    // チェックアウトに置けば、これまでどおり root 0 で出る。
    await write("photo.png", png);
    expect((await attachMessageFiles(chat, root, [extra])).messages[0]?.files).toMatchObject([
      { name: "photo.png", kind: "image", root: 0 },
    ]);
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("never accepts an image from an extra root, even without a checkout", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  await writeFile(join(extra, "photo.png"), png);
  await writeFile(join(extra, "mock.html"), "<!doctype html>");

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: "`photo.png` と `mock.html`", at: 1 }],
  };

  try {
    // チェックアウトの無いペインでは、追加根が 0 番になる。それでも画像は拾わない。
    // /files はチェックアウトだけを根にするので、拾うと 404 のチップになる。
    const attached = await attachMessageFiles(chat, null, [extra]);
    expect(attached.messages[0]?.files).toMatchObject([
      { name: "mock.html", kind: "html", root: 0 },
    ]);
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("keeps the root of a same-named file so delivery cannot swap it", async () => {
  await write("mock.html", new TextEncoder().encode("<!doctype html><p>checkout</p>"));
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  const page = join(extra, "mock.html");
  await writeFile(page, "<!doctype html><p>extra</p>");

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: `モックは \`${page}\` です。`, at: 1 }],
  };

  try {
    const files = (await attachMessageFiles(chat, root, [extra])).messages[0]?.files ?? [];
    // 絶対パスは追加根に実在するので、チェックアウトの同名ファイルではなく root 1 を記録する。
    expect(files).toMatchObject([{ name: "mock.html", kind: "html", root: 1 }]);
    // 配信も同じ根を引けば、チェックアウトの同名ファイルとは別の中身になる。
    const served = await resolvePreviewFile({ root: extra, path: files[0]!.name });
    expect(served?.path).toBe(page);
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});
