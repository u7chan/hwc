import { expect, test } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments";
import {
  ATTACHMENT_LIMIT_NOTICE,
  dropActionFrom,
  pasteActionFrom,
  uploadFailureNotice,
} from "./attachments";

function clipboardItem(type: string, file: File | null, kind = "file") {
  return { kind, type, getAsFile: () => file };
}

const png = new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });
const jpeg = new File([new Uint8Array([0xff, 0xd8])], "image.jpg", { type: "image/jpeg" });
const plain = new File(["hello"], "note.txt", { type: "text/plain" });
const svg = new File(["<svg/>"], "image.svg", { type: "image/svg+xml" });
const gif = new File(["GIF89a"], "image.gif", { type: "image/gif" });

test("the accepted images are uploaded and the default paste is prevented", () => {
  const action = pasteActionFrom([
    clipboardItem("image/png", png),
    clipboardItem("text/plain", plain),
    clipboardItem("", null, "string"),
    clipboardItem("image/jpeg", jpeg),
  ]);

  expect(action).toEqual({ kind: "upload", files: [png, jpeg], unsupported: false });
});

test("an unsupported image type is reported instead of being dropped silently", () => {
  // GIF と SVG は保存しない。何も起きないと利用者は理由を知れない。
  expect(pasteActionFrom([clipboardItem("image/gif", gif)])).toEqual({
    kind: "unsupported",
  });
  expect(
    pasteActionFrom([clipboardItem("image/gif", gif), clipboardItem("image/svg+xml", svg)]),
  ).toEqual({ kind: "unsupported" });
});

test("an unsupported image next to a supported one is uploaded and reported", () => {
  expect(
    pasteActionFrom([clipboardItem("image/png", png), clipboardItem("image/gif", gif)]),
  ).toEqual({ kind: "upload", files: [png], unsupported: true });
});

test("a paste without images keeps the default behaviour", () => {
  // テキストだけの貼り付けでは preventDefault しない。入力欄の既定動作のままにする。
  expect(pasteActionFrom([clipboardItem("text/plain", plain)])).toEqual({ kind: "default" });
  expect(pasteActionFrom([clipboardItem("", null, "string")])).toEqual({ kind: "default" });
  expect(pasteActionFrom([])).toEqual({ kind: "default" });
  expect(pasteActionFrom(null)).toEqual({ kind: "default" });
  expect(pasteActionFrom(undefined)).toEqual({ kind: "default" });
  // 画像の項目でも File が取れなければ添付しない。
  expect(pasteActionFrom([clipboardItem("image/png", null)])).toEqual({ kind: "default" });
});

test("the accepted images dropped together are uploaded and the default is prevented", () => {
  expect(dropActionFrom([png, plain, jpeg])).toEqual({
    kind: "upload",
    files: [png, jpeg],
    unsupported: false,
  });
});

test("a dropped unsupported image is reported instead of being ignored", () => {
  expect(dropActionFrom([gif])).toEqual({ kind: "unsupported" });
  expect(dropActionFrom([gif, svg])).toEqual({ kind: "unsupported" });
});

test("a dropped unsupported image next to a supported one is uploaded and reported", () => {
  expect(dropActionFrom([png, gif])).toEqual({
    kind: "upload",
    files: [png],
    unsupported: true,
  });
});

test("a drop without images keeps the default behaviour", () => {
  // 画像以外のファイルは添付しない。既定動作を止めるかどうかは呼び出し側が決める。
  expect(dropActionFrom([plain])).toEqual({ kind: "default" });
  expect(dropActionFrom([])).toEqual({ kind: "default" });
  expect(dropActionFrom(null)).toEqual({ kind: "default" });
  expect(dropActionFrom(undefined)).toEqual({ kind: "default" });
});

test("the limit notice names the number of images", () => {
  expect(ATTACHMENT_LIMIT_NOTICE).toContain("4");
});

test("an upload failure says what the user can change", () => {
  expect(uploadFailureNotice(413)).toBe(
    `画像が大きすぎます（${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB まで）`,
  );
  expect(uploadFailureNotice(415)).toBe("対応していない画像形式です（PNG / JPEG / WebP）");
  expect(uploadFailureNotice(0)).toBe("画像を送信できませんでした");
  expect(uploadFailureNotice(502)).toBe("画像を送信できませんでした");
});
