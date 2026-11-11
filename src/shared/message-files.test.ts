import { expect, test } from "bun:test";
import { previewWarning } from "./message-files";

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
