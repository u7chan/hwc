import { expect, test } from "bun:test";
import { MAX_FILE_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES } from "../shared/attachments";
import {
  ATTACHMENT_LIMIT_NOTICE,
  attachmentTooLargeNotice,
  dropActionFrom,
  exceedsAttachmentLimit,
  pasteActionFrom,
  uploadFailureNotice,
} from "./attachments";

function clipboardItem(type: string, file: File | null, kind = "file") {
  return { kind, type, getAsFile: () => file };
}

const png = new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });
const zip = new File(["PK"], "report.zip", { type: "application/zip" });
const plain = new File(["hello"], "note.txt", { type: "text/plain" });
const svg = new File(["<svg/>"], "image.svg", { type: "image/svg+xml" });
const noType = new File(["PK"], "report.zip", { type: "" });

test("every pasted file is uploaded and the default paste is prevented", () => {
  const action = pasteActionFrom([
    clipboardItem("image/png", png),
    clipboardItem("text/plain", plain),
    clipboardItem("application/zip", zip),
    clipboardItem("", null, "string"),
  ]);

  expect(action).toEqual({ kind: "upload", files: [png, plain, zip] });
});

test("a paste without files keeps the default behaviour", () => {
  // テキストだけの貼り付けでは preventDefault しない。入力欄の既定動作のままにする。
  expect(pasteActionFrom([clipboardItem("text/plain", null, "string")])).toEqual({
    kind: "default",
  });
  expect(pasteActionFrom([])).toEqual({ kind: "default" });
  expect(pasteActionFrom(null)).toEqual({ kind: "default" });
  expect(pasteActionFrom(undefined)).toEqual({ kind: "default" });
  // ファイルの項目でも File が取れなければ添付しない。
  expect(pasteActionFrom([clipboardItem("image/png", null)])).toEqual({ kind: "default" });
});

test("the dropped files are uploaded whatever the type is", () => {
  expect(dropActionFrom([png, plain, zip])).toEqual({
    kind: "upload",
    files: [png, plain, zip],
  });
  // SVG も画像形式の制限を外したので、そのまま添付の対象になる。
  expect(dropActionFrom([svg])).toEqual({ kind: "upload", files: [svg] });
  expect(dropActionFrom([noType])).toEqual({ kind: "upload", files: [noType] });
});

test("a drop without files keeps the default behaviour", () => {
  expect(dropActionFrom([])).toEqual({ kind: "default" });
  expect(dropActionFrom(null)).toEqual({ kind: "default" });
  expect(dropActionFrom(undefined)).toEqual({ kind: "default" });
});

test("the limit notice names the number of attachments", () => {
  expect(ATTACHMENT_LIMIT_NOTICE).toContain("4");
  expect(ATTACHMENT_LIMIT_NOTICE).toContain("件");
});

test("the size limit is decided by the extension, not by the browser type", () => {
  expect(exceedsAttachmentLimit({ name: "a.png", size: MAX_IMAGE_ATTACHMENT_BYTES })).toBe(false);
  expect(exceedsAttachmentLimit({ name: "a.png", size: MAX_IMAGE_ATTACHMENT_BYTES + 1 })).toBe(
    true,
  );
  // 同じ 11MB でも、画像なら超えていて、zip なら超えていない。
  expect(exceedsAttachmentLimit({ name: "a.zip", size: MAX_IMAGE_ATTACHMENT_BYTES + 1 })).toBe(
    false,
  );
  expect(exceedsAttachmentLimit({ name: "a.zip", size: MAX_FILE_ATTACHMENT_BYTES + 1 })).toBe(true);
  // 型が空でも拡張子で決まる。
  expect(exceedsAttachmentLimit({ name: "a.zip", size: 11 * 1024 * 1024 })).toBe(false);
  // 保存名に直すと拡張子が変わる名前も、BFF と同じ種別になる。
  expect(exceedsAttachmentLimit({ name: "a.png ", size: 11 * 1024 * 1024 })).toBe(true);
});

test("an upload failure says what the user can change", () => {
  expect(uploadFailureNotice(413, "image")).toBe("画像が大きすぎます（10MB まで）");
  expect(uploadFailureNotice(413, "file")).toBe("ファイルが大きすぎます（25MB まで）");
  expect(attachmentTooLargeNotice("file")).toContain("25MB");
  expect(uploadFailureNotice(0, "file")).toBe("ファイルを送信できませんでした");
  expect(uploadFailureNotice(502, "image")).toBe("ファイルを送信できませんでした");
});
