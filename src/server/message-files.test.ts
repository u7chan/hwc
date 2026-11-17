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
  listDirectory,
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
    { path: "docs/mock.png", imageRefs: ["docs/mock.png"], linkRefs: [] },
  ]);
  // インラインコード、リンク、裸のパスは末尾の一覧に残す。リンクは行き先の表記を覚える。
  expect(messagePathCandidates("`docs/mock.png` [x](docs/mock.png) docs/other.png")).toEqual([
    { path: "docs/mock.png", imageRefs: [], linkRefs: ["docs/mock.png"] },
    { path: "docs/other.png", imageRefs: [], linkRefs: [] },
  ]);
  // 裸のパスと画像記法の両方に出ても、描画位置は残す。
  expect(messagePathCandidates("docs/mock.png\n\n![モック](docs/mock.png)")).toEqual([
    { path: "docs/mock.png", imageRefs: ["docs/mock.png"], linkRefs: [] },
  ]);
  // エスケープした `!` は画像記法として読まれない。リンクとしては読まれる。
  expect(messagePathCandidates("\\![モック](docs/mock.png)")).toEqual([
    { path: "docs/mock.png", imageRefs: [], linkRefs: ["docs/mock.png"] },
  ]);
  // フェンスとインラインコードの中は描画位置にしない。
  expect(messagePathCandidates("```\n![モック](docs/mock.png)\n```")).toEqual([]);
  expect(messagePathCandidates("`![モック](docs/mock.png)`")).toEqual([
    { path: "docs/mock.png", imageRefs: [], linkRefs: [] },
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

test("ignores paths that are not local files", () => {
  expect(paths("https://example.com/a.png")).toEqual([]);
  expect(paths("[remote](https://example.com/a.png)")).toEqual([]);
  expect(paths("data:image/png;base64,AAAA")).toEqual([]);
  // 裸のパスはチップにもリンクにもならない。テキストはリンクの destination のときだけ候補になる。
  expect(paths("docs/README.md と src/app.ts")).toEqual([]);
  expect(paths("[設計](docs/README.md) と [実装](src/app.ts)")).toEqual([
    "docs/README.md",
    "src/app.ts",
  ]);
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
  await write("preview/.gitignore", new TextEncoder().encode("node_modules\n"));
  await write("preview/secrets.env", new TextEncoder().encode("TOKEN=1"));

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
  // 本文のリンクから開くテキストは配るが、必ず text/plain（ADR 0084）。
  expect((await resolvePreviewFile({ root, path: "preview/notes.txt" }))?.contentType).toBe(
    "text/plain; charset=utf-8",
  );
  // ドットファイルも配る。`.env` 系だけがブラックリスト。
  expect((await resolvePreviewFile({ root, path: "preview/.gitignore" }))?.contentType).toBe(
    "text/plain; charset=utf-8",
  );
  // 一覧に無い形式と、ブラックリストの `.env` 系は配信しない。
  expect(await resolvePreviewFile({ root, path: "preview/secrets.env" })).toBeNull();
  expect(await resolvePreviewFile({ root, path: "preview/.env" })).toBeNull();
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

// 本文のリンクから開く相対パス。ADR 0084。
function agentChat(text: string): ChatSnapshot {
  return { ...snapshot, messages: [{ id: "a1", role: "agent", text, at: 1 }] };
}

test("resolves a relative link to a text file and leaves a bare path as text", async () => {
  await write("docs/notes.md", new TextEncoder().encode("# notes"));

  const message = (
    await attachMessageFiles(
      agentChat("[設計](docs/notes.md) と docs/notes.md を見てください。"),
      root,
    )
  ).messages[0];

  expect(message?.links?.map((link) => [link.href, link.kind, link.name, link.root])).toEqual([
    ["docs/notes.md", "text", "docs/notes.md", 0],
  ]);
  // テキストはチップにしない。本文のリンクからだけ開ける。
  expect(message?.files).toBeUndefined();
});

test("does not link .env or a file without an allowed extension", async () => {
  await write("docs/.env", new TextEncoder().encode("TOKEN=1"));
  await write("docs/.env.local", new TextEncoder().encode("TOKEN=1"));
  await write("docs/secrets.env", new TextEncoder().encode("TOKEN=1"));

  const message = (
    await attachMessageFiles(
      agentChat("[a](docs/.env) [b](docs/.env.local) [c](docs/secrets.env)"),
      root,
    )
  ).messages[0];

  // ブラックリストの `.env` 系と、一覧に無い `env` はリンクにしない。
  expect(message?.links).toBeUndefined();
  expect(message?.files).toBeUndefined();
});

test("links an extensionless file as text", async () => {
  await write("LICENSE", new TextEncoder().encode("MIT License\n"));

  const message = (await attachMessageFiles(agentChat("[ライセンス](LICENSE)"), root)).messages[0];

  expect(message?.links?.map((link) => [link.href, link.kind, link.name])).toEqual([
    ["LICENSE", "text", "LICENSE"],
  ]);
  // 裸の語は、実在してもリンクにしない。
  expect(
    (await attachMessageFiles(agentChat("LICENSE を読んでください。"), root)).messages[0]?.links,
  ).toBeUndefined();
});

test("keeps the chip and the link for the same HTML file", async () => {
  await write("docs/mock.html", new TextEncoder().encode("<!doctype html>"));

  const message = (await attachMessageFiles(agentChat("[モック](docs/mock.html)"), root))
    .messages[0];

  expect(message?.files?.map((file) => file.name)).toEqual(["docs/mock.html"]);
  expect(message?.links?.map((link) => [link.href, link.kind])).toEqual([
    ["docs/mock.html", "html"],
  ]);
});

test("does not link an absolute URL or a file outside the root", async () => {
  const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
  await writeFile(join(outside, "notes.md"), "# notes");

  try {
    const text = `[web](https://example.com/a.md) [外](${join(outside, "notes.md")})`;
    const message = (await attachMessageFiles(agentChat(text), root)).messages[0];
    expect(message?.links).toBeUndefined();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("changes the etag when a linked file changes", async () => {
  await write("docs/notes.md", new TextEncoder().encode("# notes"));

  const before = await attachMessageFiles(agentChat("[設計](docs/notes.md)"), root);
  await write("docs/notes.md", new TextEncoder().encode("# notes\n\n追記"));
  const after = await attachMessageFiles(agentChat("[設計](docs/notes.md)"), root);

  expect(after.etag).not.toBe(before.etag);
});

test("bare text paths do not use up the file slots", async () => {
  await write("docs/shot.png", png);
  // 実在するかどうかより前に、候補の枠（20 件）で後ろの画像が落ちていた。
  const bare = Array.from({ length: 20 }, (_, index) => `pkg/f${index}.ts`).join(" ");

  const message = (await attachMessageFiles(agentChat(`${bare} docs/shot.png`), root)).messages[0];

  expect(message?.files?.map((file) => file.name)).toEqual(["docs/shot.png"]);
});

test("links dot files except .env and its variants", async () => {
  await write("docs/.env.yaml", new TextEncoder().encode("token: 1"));
  await write("docs/.secrets.md", new TextEncoder().encode("# secret"));
  await write(".gitignore", new TextEncoder().encode("node_modules\n"));
  await write(".github/workflows/ci.yml", new TextEncoder().encode("on: push"));

  const message = (
    await attachMessageFiles(
      agentChat(
        "[a](docs/.env.yaml) [b](docs/.secrets.md) [c](.gitignore) [d](.github/workflows/ci.yml)",
      ),
      root,
    )
  ).messages[0];
  expect(message?.links?.map((link) => link.name)).toEqual([
    "docs/.secrets.md",
    ".gitignore",
    ".github/workflows/ci.yml",
  ]);
});

test("lists a directory with dirs first and the kind each file opens with", async () => {
  await write("src/app.ts", new TextEncoder().encode("export {}"));
  await write("docs/mock.png", png);
  await write("docs/mock.html", new TextEncoder().encode("<!doctype html>"));
  await write(".gitignore", new TextEncoder().encode("node_modules\n"));
  await write(".env", new TextEncoder().encode("TOKEN=1"));
  await write("Makefile", new TextEncoder().encode("all:\n"));
  await write("empty.md", new Uint8Array());
  await write("z.txt", new TextEncoder().encode("z"));
  await write(".git/HEAD", new TextEncoder().encode("ref: refs/heads/main"));

  const listing = await listDirectory({ root, path: "" });

  expect(listing).not.toBeNull();
  expect(listing?.total).toBe(7);
  expect(listing?.truncated).toBe(false);
  expect(listing?.entries.map((entry) => [entry.kind, entry.name])).toEqual([
    ["dir", "docs"],
    ["dir", "src"],
    ["file", ".env"],
    ["file", ".gitignore"],
    ["file", "empty.md"],
    ["file", "Makefile"],
    ["file", "z.txt"],
  ]);

  const byName = new Map(listing?.entries.map((entry) => [entry.name, entry]));
  expect(byName.get("src")).toMatchObject({ kind: "dir", path: "src", expandable: true });
  expect(byName.get("app.ts")).toBeUndefined();
  expect(byName.get("docs")).toMatchObject({ kind: "dir", path: "docs" });
  expect(byName.get("empty.md")).toMatchObject({ kind: "file", open: null });
  expect(byName.get("Makefile")).toMatchObject({ kind: "file", open: "text" });
  expect(byName.get(".gitignore")).toMatchObject({ kind: "file", open: "text" });
  expect(byName.get(".env")).toMatchObject({ kind: "file", open: null });

  const src = await listDirectory({ root, path: "src" });
  expect(src?.entries).toMatchObject([
    { kind: "file", name: "app.ts", path: "src/app.ts", open: "text" },
  ]);
  const docs = await listDirectory({ root, path: "docs" });
  expect(docs?.entries.map((entry) => entry.name)).toEqual(["mock.html", "mock.png"]);
  expect(docs?.entries.find((entry) => entry.name === "mock.html")).toMatchObject({
    kind: "file",
    path: "docs/mock.html",
    open: "html",
  });
  expect(docs?.entries.find((entry) => entry.name === "mock.png")).toMatchObject({
    kind: "file",
    path: "docs/mock.png",
    open: "image",
  });
});

test("shows dot directories but never .git", async () => {
  await write(".github/workflows/ci.yml", new TextEncoder().encode("on: push"));
  await write(".git/config", new TextEncoder().encode("[core]"));

  const rootListing = await listDirectory({ root, path: "" });
  expect(rootListing?.entries.map((entry) => entry.name)).toEqual([".github"]);

  const github = await listDirectory({ root, path: ".github" });
  expect(github?.entries.map((entry) => entry.name)).toEqual(["workflows"]);
});

test("keeps a symlink outside the root as a name that cannot be opened", async () => {
  const outside = await mkdtemp(join(tmpdir(), "hwc-tree-outside-"));
  await mkdir(join(outside, "dir"), { recursive: true });
  await writeFile(join(outside, "secret.md"), "secret");
  await symlink(join(outside, "dir"), join(root, "outside-dir"));
  await symlink(join(outside, "secret.md"), join(root, "outside.md"));
  await symlink(join(outside, "missing.md"), join(root, "broken.md"));

  try {
    const listing = await listDirectory({ root, path: "" });
    const byName = new Map(listing?.entries.map((entry) => [entry.name, entry]));
    // 根の外を指すディレクトリは名前だけ残し、展開させない。
    expect(byName.get("outside-dir")).toMatchObject({ kind: "dir", expandable: false });
    expect(byName.get("outside.md")).toMatchObject({ kind: "file", open: null });
    expect(byName.get("broken.md")).toMatchObject({ kind: "file", open: null });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("never serves or lists anything under .git", async () => {
  await write(
    ".git/config",
    new TextEncoder().encode("[remote]\n url = https://token@example.com/repo\n"),
  );
  await write(".git/logo.png", png);
  await write(".gitignore", new TextEncoder().encode("node_modules\n"));
  await symlink(join(root, ".git"), join(root, "git-link"));
  await symlink(join(root, ".git", "config"), join(root, "config-link"));

  expect(await resolvePreviewFile({ root, path: ".git/config" })).toBeNull();
  expect(await resolvePreviewFile({ root, path: ".git" })).toBeNull();
  expect(await resolvePreviewFile({ root, path: join(root, ".git", "config") })).toBeNull();
  expect(await resolvePreviewFile({ root, path: "config-link" })).toBeNull();
  expect(await resolveMessageFile({ root, path: ".git/logo.png" })).toBeNull();
  expect(await listDirectory({ root, path: ".git" })).toBeNull();
  expect(await listDirectory({ root, path: "git-link" })).toBeNull();

  const listing = await listDirectory({ root, path: "" });
  const byName = new Map(listing?.entries.map((entry) => [entry.name, entry]));
  // `.git` そのものは出さず、そこへ向かうリンクも名前だけ残して開かせない。
  expect(byName.get(".git")).toBeUndefined();
  expect(byName.get("git-link")).toMatchObject({ kind: "dir", expandable: false });
  expect(byName.get("config-link")).toMatchObject({ kind: "file", open: null });
  expect(byName.get(".gitignore")).toMatchObject({ kind: "file", open: "text" });
});

test("follows a symlink inside the root and keeps the requested path", async () => {
  await write("docs/mock.png", png);
  await symlink(join(root, "docs"), join(root, "docs-link"));

  const listing = await listDirectory({ root, path: "docs-link" });

  expect(listing?.entries).toMatchObject([
    { kind: "file", name: "mock.png", path: "docs-link/mock.png", open: "image" },
  ]);
});

test("refuses a path outside the root, a file, and a missing directory", async () => {
  await write("docs/mock.png", png);
  const outside = await mkdtemp(join(tmpdir(), "hwc-tree-outside-"));

  try {
    for (const path of [
      "../",
      `../${basename(outside)}`,
      outside,
      "docs/mock.png",
      "missing",
      "docs/../docs",
    ]) {
      expect(await listDirectory({ root, path })).toBeNull();
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("caps a directory at 200 rows and reports the total", async () => {
  await Promise.all(
    Array.from({ length: 205 }, (_, index) =>
      write(`bulk/f${String(index).padStart(3, "0")}.md`, new TextEncoder().encode("x")),
    ),
  );

  const listing = await listDirectory({ root, path: "bulk" });

  expect(listing?.entries).toHaveLength(200);
  expect(listing?.total).toBe(205);
  expect(listing?.truncated).toBe(true);
  expect(listing?.entries[0]?.name).toBe("f000.md");
  expect(listing?.entries.at(-1)?.name).toBe("f199.md");
});

test("lists a POSIX file name that contains a backslash", async () => {
  await write("docs/back\\slash.md", new TextEncoder().encode("text"));

  const listing = await listDirectory({ root, path: "docs" });

  expect(listing?.entries).toMatchObject([
    { kind: "file", name: "back\\slash.md", path: "docs/back\\slash.md", open: "text" },
  ]);
});
