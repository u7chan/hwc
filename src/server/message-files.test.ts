import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_PREVIEW_FILE_BYTES } from "../shared/attachments";
import type { ChatSnapshot } from "./chat/contract";
import {
  attachMessageFiles,
  collectMessageFiles,
  defaultPreviewRoots,
  messagePathCandidates,
  previewRootLabel,
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

// 候補は描画位置の照合キーも持つ。パスだけを見たいテストはここで落とす。
function paths(text: string): string[] {
  return messagePathCandidates(text).map((candidate) => candidate.path);
}

test("collects paths from prose, inline code, links and images", () => {
  const text = [
    "モックは `.artifacts/mock.png` に置きました。",
    "元の画像は docs/before.jpg です。",
    "![比較](docs/after.webp)",
    "詳細は [こちら](docs/preview.jpeg) を見てください。",
  ].join("\n");

  expect(paths(text)).toEqual([
    ".artifacts/mock.png",
    "docs/before.jpg",
    "docs/after.webp",
    "docs/preview.jpeg",
  ]);
});

test("finds a path in inline code with no spaces around it", () => {
  expect(paths("空状態の確認に使った画面です。`docs/preview/app-icon.png` に置きました。")).toEqual(
    ["docs/preview/app-icon.png"],
  );
});

test("marks only image notation as a drawing position", () => {
  expect(messagePathCandidates("![モック](docs/mock.png)")).toEqual([
    { path: "docs/mock.png", imageRefs: ["docs/mock.png"] },
  ]);
  // インラインコード、リンク、裸のパスは末尾の一覧に残す。
  expect(messagePathCandidates("`docs/mock.png` [x](docs/mock.png) docs/other.png")).toEqual([
    { path: "docs/mock.png", imageRefs: [] },
    { path: "docs/other.png", imageRefs: [] },
  ]);
  // 裸のパスと画像記法の両方に出ても、描画位置は残す。
  expect(messagePathCandidates("docs/mock.png\n\n![モック](docs/mock.png)")).toEqual([
    { path: "docs/mock.png", imageRefs: ["docs/mock.png"] },
  ]);
  // エスケープした `!` は画像記法として読まれない。
  expect(messagePathCandidates("\\![モック](docs/mock.png)")).toEqual([
    { path: "docs/mock.png", imageRefs: [] },
  ]);
  // フェンスとインラインコードの中は描画位置にしない。
  expect(messagePathCandidates("```\n![モック](docs/mock.png)\n```")).toEqual([]);
  expect(messagePathCandidates("`![モック](docs/mock.png)`")).toEqual([
    { path: "docs/mock.png", imageRefs: [] },
  ]);
});

test("drops a sentence period or a Japanese particle after the extension", () => {
  expect(paths("The mock is at docs/mock.png.")).toEqual(["docs/mock.png"]);
  expect(paths("スクショはdocs/mock.pngに置きました。")).toEqual(["docs/mock.png"]);
  // 全角コロンの後ろでも拾う。
  expect(paths("モック：docs/mock.png")).toEqual(["docs/mock.png"]);
  // 別の拡張子が続く名前は画像として扱わない。
  expect(paths("docs/mock.png.bak")).toEqual([]);
  // 日本語のファイル名はそのまま残す。
  expect(paths("モック.png")).toEqual(["モック.png"]);
});

test("splits paths joined by punctuation in one token", () => {
  // 全角の区切りで並んだ 2 枚を別々に拾う。区切りの分割が効かないと 1 件にもならない。
  expect(paths("docs/a.png、docs/b.png")).toEqual(["docs/a.png", "docs/b.png"]);
  expect(paths("（docs/a.png）")).toEqual(["docs/a.png"]);
});

test("does not look inside fenced code", () => {
  expect(paths("```sh\nopen docs/mock.png\n```\n")).toEqual([]);
  expect(paths("~~~\n![x](a.png)\n~~~\n`b.png`")).toEqual(["b.png"]);
});

test("ignores paths that are not local images", () => {
  expect(paths("https://example.com/a.png")).toEqual([]);
  expect(paths("[remote](https://example.com/a.png)")).toEqual([]);
  expect(paths("data:image/png;base64,AAAA")).toEqual([]);
  expect(paths("docs/README.md と src/app.ts")).toEqual([]);
});

test("keeps each path once and stops at the candidate limit", () => {
  expect(paths("a.png `a.png` [x](a.png)")).toEqual(["a.png"]);

  const many = Array.from({ length: 30 }, (_, index) => `f${index}.png`).join(" ");
  expect(messagePathCandidates(many)).toHaveLength(20);
});

test("finds an existing image below the root", async () => {
  await write("docs/mock.png", png);

  const files = await collectMessageFiles("![モック](docs/mock.png)", root);

  expect(files.map((file) => ({ name: file.name, kind: file.kind }))).toEqual([
    { name: "docs/mock.png", kind: "image" },
  ]);
  // 画像記法の destination は照合キーとして残る。本文のその位置に描くために使う。
  expect(files[0]?.imageRefs).toEqual(["docs/mock.png"]);
  expect(files[0]?.version).toMatch(/^\d+-\d+$/);
});

test("keeps every image notation that points at the same file", async () => {
  await write("docs/mock.png", png);

  const files = await collectMessageFiles(
    "![A](./docs/mock.png)\n\n![B](docs/mock.png)\n\n`docs/mock.png`",
    root,
  );

  // 同じ実体は 1 件にまとめ、描画位置だけを全部持つ。
  expect(files).toHaveLength(1);
  expect(files[0]?.imageRefs).toEqual(["./docs/mock.png", "docs/mock.png"]);
});

test("does not attach image refs to HTML", async () => {
  await write("docs/preview/index.html", new TextEncoder().encode("<!doctype html>"));

  const files = await collectMessageFiles("![モック](docs/preview/index.html)", root);

  expect(files[0]?.kind).toBe("html");
  expect(files[0]?.imageRefs).toBeUndefined();
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
  await write("big.png", new Uint8Array(MAX_PREVIEW_FILE_BYTES + 1));

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

test("keeps /tmp as the first extra root and appends the environment", () => {
  expect(defaultPreviewRoots({})).toEqual(["/tmp"]);
  expect(defaultPreviewRoots({ HWC_PREVIEW_ROOTS: "" })).toEqual(["/tmp"]);
  // 相対パスは作業ディレクトリに依存するので採らない。
  expect(defaultPreviewRoots({ HWC_PREVIEW_ROOTS: "relative:/tmp/mock" })).toEqual([
    "/tmp",
    "/tmp/mock",
  ]);
  expect(defaultPreviewRoots({ HWC_PREVIEW_ROOTS: "/tmp/a:/tmp/b" })).toEqual([
    "/tmp",
    "/tmp/a",
    "/tmp/b",
  ]);
  // 表記が違っても同じ実体は 1 回だけ試す。
  expect(defaultPreviewRoots({ HWC_PREVIEW_ROOTS: "/tmp/" })).toEqual(["/tmp"]);
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

test("delivers an HTML under /tmp with the default roots and reports no outside file", async () => {
  const dir = await mkdtemp(join("/tmp", "hwc-default-root-"));
  const page = join(dir, "mock.html");
  await writeFile(page, "<!doctype html>");

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: `モックは \`${page}\` です。`, at: 1 }],
  };

  try {
    const message = (await attachMessageFiles(chat, root, defaultPreviewRoots({}))).messages[0];
    expect(message?.files).toMatchObject([
      { name: `${basename(dir)}/mock.html`, kind: "html", root: 1 },
    ]);
    expect(message?.outsideFile).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("labels the roots other than the checkout", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  await writeFile(join(extra, "mock.html"), "<!doctype html>");
  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: "`docs/mock.png` を見てください。", at: 1 }],
  };

  try {
    await write("docs/mock.png", png);
    // チェックアウトは既定の根なので、ラベルを持たない。
    const checkout = await attachMessageFiles(chat, root, [extra]);
    expect(checkout.messages[0]?.files?.[0]).toMatchObject({ root: 0 });
    expect(checkout.messages[0]?.files?.[0]?.rootLabel).toBeUndefined();

    const html: ChatSnapshot = {
      ...chat,
      messages: [
        { id: "a1", role: "agent", text: `モックは \`${join(extra, "mock.html")}\` です。`, at: 1 },
      ],
    };
    const labelled = await attachMessageFiles(html, root, [extra]);
    expect(labelled.messages[0]?.files?.[0]).toMatchObject({
      root: 1,
      rootLabel: basename(extra),
    });
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("labels /tmp from the configured value, even when it is root 0", async () => {
  const dir = await mkdtemp(join("/tmp", "hwc-default-root-"));
  const page = join(dir, "mock.html");
  await writeFile(page, "<!doctype html>");
  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: `モックは \`${page}\` です。`, at: 1 }],
  };

  try {
    const withCheckout = (await attachMessageFiles(chat, root, ["/tmp"])).messages[0];
    expect(withCheckout?.files?.[0]).toMatchObject({ root: 1, rootLabel: "/tmp" });

    // チェックアウトを持たないペインでは /tmp が 0 番になる。番号ではなく設定値で決める。
    const withoutCheckout = (await attachMessageFiles(chat, null, ["/tmp"])).messages[0];
    expect(withoutCheckout?.files?.[0]).toMatchObject({ root: 0, rootLabel: "/tmp" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to the default label when the root has no basename", () => {
  expect(previewRootLabel("/tmp")).toBe("/tmp");
  expect(previewRootLabel("/srv/mock")).toBe("mock");
  expect(previewRootLabel("/srv/mock/")).toBe("mock");
  // 空文字と `/` はベース名にならない。ラベルを黙って消さず、既定の文言を出す。
  expect(previewRootLabel("")).toBe("追加根");
  expect(previewRootLabel("/")).toBe("追加根");
});

test("finds an image in an extra root and keeps the root it was found in", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  await writeFile(join(extra, "photo.png"), png);

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: "`photo.png` と `photo.png`", at: 1 }],
  };

  try {
    expect((await attachMessageFiles(chat, root, [extra])).messages[0]?.files).toMatchObject([
      { name: "photo.png", kind: "image", root: 1 },
    ]);

    // チェックアウトにも置けば、検出順で 0 番が勝つ。
    await write("photo.png", png);
    expect((await attachMessageFiles(chat, root, [extra])).messages[0]?.files).toMatchObject([
      { name: "photo.png", kind: "image", root: 0 },
    ]);
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("finds an image in an extra root even without a checkout", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  await writeFile(join(extra, "photo.png"), png);
  await writeFile(join(extra, "mock.html"), "<!doctype html>");

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: "`photo.png` と `mock.html`", at: 1 }],
  };

  try {
    // チェックアウトの無いペインでは、追加根が 0 番になる。配信も同じ番号を使う。
    const attached = await attachMessageFiles(chat, null, [extra]);
    expect(attached.messages[0]?.files).toMatchObject([
      { name: "photo.png", kind: "image", root: 0 },
      { name: "mock.html", kind: "html", root: 0 },
    ]);
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("reports the name of an absolute file that exists outside every root", async () => {
  const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
  await writeFile(join(outside, "shell-agent.html"), "<!doctype html>");
  await writeFile(join(outside, "overview.png"), png);

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [
      {
        id: "a1",
        role: "agent",
        text: `モックは \`${join(outside, "shell-agent.html")}\` と \`${join(outside, "overview.png")}\` です。`,
        at: 1,
      },
    ],
  };

  try {
    const message = (await attachMessageFiles(chat, root)).messages[0];
    // 配れないので files は空のまま、理由のために名前だけを持つ。絶対パスは返さない。
    expect(message?.files).toBeUndefined();
    expect(message?.outsideFile).toBe("shell-agent.html");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("does not report a file that the extra roots can deliver", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  const page = join(extra, "mock.html");
  await writeFile(page, "<!doctype html>");

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: `モックは \`${page}\` です。`, at: 1 }],
  };

  try {
    const message = (await attachMessageFiles(chat, root, [extra])).messages[0];
    expect(message?.files).toMatchObject([{ name: "mock.html", root: 1 }]);
    expect(message?.outsideFile).toBeUndefined();
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("reports nothing when the path is not absolute, missing, or not deliverable", async () => {
  const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
  await writeFile(join(outside, "notes.txt"), "log");
  await writeFile(join(outside, "empty.html"), "");
  // チェックアウトの中でも、サイズ 0 は配れない。理由は「根の外」ではない。
  await writeFile(join(root, "empty.png"), "");

  const text = [
    "`mock.html`",
    `\`${join(outside, "missing.html")}\``,
    `\`${join(outside, "notes.txt")}\``,
    `\`${join(outside, "empty.html")}\``,
    "`empty.png`",
  ].join(" と ");
  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text, at: 1 }],
  };

  try {
    const message = (await attachMessageFiles(chat, root)).messages[0];
    expect(message?.files).toBeUndefined();
    expect(message?.outsideFile).toBeUndefined();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("still reports an outside file after the file slots are full", async () => {
  const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
  const page = join(outside, "late.html");
  await writeFile(page, "<!doctype html>");

  const names = ["a.html", "b.html", "c.html", "d.html"];
  for (const name of names) await write(name, new TextEncoder().encode("<!doctype html>"));

  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [
      {
        id: "a1",
        role: "agent",
        text: [...names.map((name) => `\`${name}\``), `\`${page}\``].join(" "),
        at: 1,
      },
    ],
  };

  try {
    const message = (await attachMessageFiles(chat, root)).messages[0];
    // 配る枠は 4 件で止めるが、案内は後ろの候補も見る。
    expect(message?.files).toHaveLength(4);
    expect(message?.outsideFile).toBe("late.html");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("changes the etag when an outside file appears without new messages", async () => {
  const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
  const page = join(outside, "mock.html");
  const chat: ChatSnapshot = {
    ...snapshot,
    messages: [{ id: "a1", role: "agent", text: `モックは \`${page}\` です。`, at: 1 }],
  };

  try {
    const before = await attachMessageFiles(chat, root);
    expect(before.messages[0]?.outsideFile).toBeUndefined();

    await writeFile(page, "<!doctype html>");
    const after = await attachMessageFiles(chat, root);
    expect(after.messages[0]?.outsideFile).toBe("mock.html");
    // 本文が同じでも、案内が変わったら 304 で古いスナップショットを返さない。
    expect(after.etag).not.toBe(before.etag);
  } finally {
    await rm(outside, { recursive: true, force: true });
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
