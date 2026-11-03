import { expect, test } from "bun:test";
import { ATTACHMENT_LIMIT_NOTICE, imageFilesFrom, uploadFailureNotice } from "./attachments";

function clipboardItem(type: string, file: File | null, kind = "file") {
  return { kind, type, getAsFile: () => file };
}

const png = new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });
const jpeg = new File([new Uint8Array([0xff, 0xd8])], "image.jpg", { type: "image/jpeg" });
const plain = new File(["hello"], "note.txt", { type: "text/plain" });
const svg = new File(["<svg/>"], "image.svg", { type: "image/svg+xml" });

test("only the image types the BFF accepts become files", () => {
  const files = imageFilesFrom([
    clipboardItem("image/png", png),
    clipboardItem("text/plain", plain),
    clipboardItem("image/svg+xml", svg),
    clipboardItem("", null, "string"),
    clipboardItem("image/jpeg", jpeg),
  ]);

  expect(files).toEqual([png, jpeg]);
});

test("a paste without clipboard data yields nothing", () => {
  expect(imageFilesFrom(null)).toEqual([]);
  expect(imageFilesFrom(undefined)).toEqual([]);
  expect(imageFilesFrom([])).toEqual([]);
  // 画像の項目でも File が取れなければ添付しない。
  expect(imageFilesFrom([clipboardItem("image/png", null)])).toEqual([]);
});

test("the limit notice names the number of images", () => {
  expect(ATTACHMENT_LIMIT_NOTICE).toContain("4");
});

test("an upload failure says what the user can change", () => {
  expect(uploadFailureNotice(413)).toContain("大きすぎます");
  expect(uploadFailureNotice(415)).toContain("形式");
  expect(uploadFailureNotice(0)).toBe("画像を送信できませんでした");
  expect(uploadFailureNotice(502)).toBe("画像を送信できませんでした");
});
