import { expect, test } from "bun:test";
import {
  looksBinary,
  messageLinkKindFromName,
  previewContentType,
  previewWarning,
} from "./message-files";

// 案内を出すのは、iframe の中で白くなる原因の 1 つ目（配信できない script）だけ。
const page = (script: string) => `<!doctype html><html><body>${script}</body></html>`;

test("warns about a relative script the preview cannot serve", () => {
  expect(previewWarning(page('<script src="./app.tsx"></script>'))).toBe("script");
  expect(previewWarning(page('<script src="app.tsx"></script>'))).toBe("script");
  expect(previewWarning(page('<script type="module" src="./src/main.tsx"></script>'))).toBe(
    "script",
  );
  // 拡張子の大文字小文字は同じに扱う。
  expect(previewWarning(page('<script src="./app.TSX"></script>'))).toBe("script");
  expect(previewWarning(page('<script src="./app.js"></script>'))).toBeNull();
  expect(previewWarning(page('<script src="./app.JS"></script>'))).toBeNull();
});

test("warns about a root relative script outside the serve list", () => {
  expect(previewWarning(page('<script src="/src/client/main.tsx"></script>'))).toBe("script");
  // サイト直下に解決されるが、拡張子が配信できれば案内は出さない。
  expect(previewWarning(page('<script src="/app.js"></script>'))).toBeNull();
});

test("drops the query and hash before looking at the extension", () => {
  expect(previewWarning(page('<script src="./app.js?v=2"></script>'))).toBeNull();
  expect(previewWarning(page('<script src="./app.js#top"></script>'))).toBeNull();
  expect(previewWarning(page('<script src="./app.tsx?v=2"></script>'))).toBe("script");
});

test("reads the src attribute in any order and with any quoting", () => {
  expect(previewWarning(page("<script defer src='./app.tsx'></script>"))).toBe("script");
  expect(previewWarning(page('<script src=./app.tsx type="module"></script>'))).toBe("script");
  expect(previewWarning(page("<script\n  data-x='a>b'\n  src='./app.tsx'\n></script>"))).toBe(
    "script",
  );
  // ブラウザは最初の src を使う。2 つ目で上書きしない。
  expect(previewWarning(page('<script src="./app.js" src="./app.tsx"></script>'))).toBeNull();
});

test("does not judge scripts that hwc does not serve", () => {
  expect(previewWarning(page('<script src="https://example.com/app.tsx"></script>'))).toBeNull();
  expect(previewWarning(page('<script src="//cdn.example.com/app.tsx"></script>'))).toBeNull();
  expect(previewWarning(page('<script src="data:text/javascript,1"></script>'))).toBeNull();
});

test("does not look inside comments or inline scripts", () => {
  expect(previewWarning(page("<!-- <script src='./app.tsx'></script> -->"))).toBeNull();
  expect(
    previewWarning(page("<script>const tag = '<script src=\"./app.tsx\"></script>';</script>")),
  ).toBeNull();
  // インライン script の後ろの本物のタグは見る。
  expect(
    previewWarning(page('<script>const ready = true;</script><script src="./app.tsx"></script>')),
  ).toBe("script");
});

test("ignores tags other than script", () => {
  expect(previewWarning(page('<link rel="stylesheet" href="./app.css">'))).toBeNull();
  expect(previewWarning(page('<img src="./shot.tsx">'))).toBeNull();
  expect(previewWarning("")).toBeNull();
});

// 本文の相対パスのリンクから開ける形式（ADR 0109）。拡張子の一覧はここ 1 か所。
test("links text files by extension, extensionless names, and dotfiles", () => {
  expect(messageLinkKindFromName("docs/notes.md")).toBe("text");
  expect(messageLinkKindFromName("data/report.csv")).toBe("text");
  expect(messageLinkKindFromName("src/app.ts")).toBe("text");
  expect(messageLinkKindFromName("docs/README.MD")).toBe("text");
  // 画像と HTML はチップと同じ見せ方のまま。
  expect(messageLinkKindFromName("docs/shot.png")).toBe("image");
  expect(messageLinkKindFromName("docs/mock.html")).toBe("html");
  // 拡張子の一覧に無いものは入らない。
  expect(messageLinkKindFromName("docs/secrets.env")).toBeNull();
  // 拡張子の無いファイルは開ける。中身がテキストかは配信するときに確かめる。
  expect(messageLinkKindFromName("LICENSE")).toBe("text");
  expect(messageLinkKindFromName("Makefile")).toBe("text");
  expect(messageLinkKindFromName("docs/settings")).toBe("text");
  // ドットファイルも開ける。ブラックリストは `.env` とその派生だけ。
  expect(messageLinkKindFromName("docs/.gitignore")).toBe("text");
  expect(messageLinkKindFromName("docs/.oxfmtrc.json")).toBe("text");
  expect(messageLinkKindFromName("docs/.secrets.md")).toBe("text");
  expect(messageLinkKindFromName("docs/.LICENSE")).toBe("text");
  expect(messageLinkKindFromName("docs/.env")).toBeNull();
  expect(messageLinkKindFromName("docs/.env.local")).toBeNull();
  expect(messageLinkKindFromName("docs/.env.yaml")).toBeNull();
  expect(messageLinkKindFromName("docs/.env.example")).toBeNull();
  expect(messageLinkKindFromName("docs/.ENV")).toBeNull();
  // ディレクトリがドット始まりでも、ファイル名が普通なら対象。
  expect(messageLinkKindFromName(".github/workflows/ci.yml")).toBe("text");
  expect(messageLinkKindFromName("docs/archive.zip")).toBeNull();
  // 実行させたくないので、テキストは必ず text/plain で配る。
  expect(previewContentType("src/app.ts")).toBe("text/plain; charset=utf-8");
  expect(previewContentType("docs/notes.md")).toBe("text/plain; charset=utf-8");
  expect(previewContentType("LICENSE")).toBe("text/plain; charset=utf-8");
  expect(previewContentType(".gitignore")).toBe("text/plain; charset=utf-8");
  expect(previewContentType(".env")).toBeNull();
});

test("treats a NUL in the head as binary", () => {
  expect(looksBinary(new TextEncoder().encode("MIT License\n"))).toBe(false);
  expect(looksBinary(new Uint8Array([0x4c, 0x49, 0x43, 0x00, 0x4e]))).toBe(true);
  // 先頭 8000 バイトより後ろの NUL は見ない。巨大なバイナリを読み切らないため。
  const lateNul = new Uint8Array(9000).fill(0x41);
  lateNul[8500] = 0;
  expect(looksBinary(lateNul)).toBe(false);
});
