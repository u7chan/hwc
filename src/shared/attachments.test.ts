import { expect, test } from "bun:test";
import {
  attachmentContentType,
  attachmentExtOf,
  attachmentName,
  attachmentTypeLabels,
  composeAttachedFilesNote,
  composeInputText,
  formatMegaBytes,
  isAttachmentName,
  isSafePaneId,
  MAX_ATTACHMENT_BYTES,
  stripAttachedFiles,
} from "./attachments";

const at = new Date(2026, 10, 3, 12, 0, 0);

test("a saved name carries the local time and the extension the type maps to", () => {
  expect(attachmentName("png", at)).toBe("pasted-20261103-120000.png");
  expect(attachmentName("jpg", at)).toBe("pasted-20261103-120000.jpg");
  expect(attachmentName("webp", at)).toBe("pasted-20261103-120000.webp");
});

test("a name that is already taken gets a number instead of an overwrite", () => {
  expect(attachmentName("png", at, 1)).toBe("pasted-20261103-120000-1.png");
  expect(attachmentName("png", at, 12)).toBe("pasted-20261103-120000-12.png");
});

test("only the three image types are accepted, with or without parameters", () => {
  expect(attachmentExtOf("image/png")).toBe("png");
  expect(attachmentExtOf("image/jpeg")).toBe("jpg");
  expect(attachmentExtOf("image/webp")).toBe("webp");
  expect(attachmentExtOf("IMAGE/PNG; charset=binary")).toBe("png");

  for (const type of ["image/svg+xml", "image/gif", "text/plain", "application/octet-stream"]) {
    expect(attachmentExtOf(type)).toBeNull();
  }
  expect(attachmentExtOf(undefined)).toBeNull();
});

test("the labels for the notice come from the allowlist", () => {
  expect(attachmentTypeLabels()).toBe("PNG / JPEG / WebP");
});

test("a byte limit is shown in whole megabytes", () => {
  expect(formatMegaBytes(MAX_ATTACHMENT_BYTES)).toBe("10MB");
  expect(formatMegaBytes(1024 * 1024)).toBe("1MB");
  expect(formatMegaBytes(1.5 * 1024 * 1024)).toBe("1.5MB");
});

test("a saved name maps back to the type it is served as", () => {
  expect(attachmentContentType("pasted-20261103-120000.png")).toBe("image/png");
  expect(attachmentContentType("pasted-20261103-120000-1.jpg")).toBe("image/jpeg");
  expect(attachmentContentType("pasted-20261103-120000.webp")).toBe("image/webp");
  expect(attachmentContentType("notes.png")).toBeNull();
});

test("a name is accepted only in the format the server writes", () => {
  expect(isAttachmentName("pasted-20261103-120000.png")).toBe(true);
  expect(isAttachmentName("pasted-20261103-120000-3.jpg")).toBe(true);
  expect(isAttachmentName("pasted-20261103-120000-3.webp")).toBe(true);

  for (const name of [
    "pasted-2026-11-03.png",
    "pasted-20261103-120000.gif",
    "pasted-20261103-120000",
    "../pasted-20261103-120000.png",
    "/etc/pasted-20261103-120000.png",
    "pasted-20261103-120000.png.txt",
    "",
  ]) {
    expect(isAttachmentName(name)).toBe(false);
  }
});

test("a pane id is a directory name, so separators and parent references are refused", () => {
  expect(isSafePaneId("w1:p1")).toBe(true);
  expect(isSafePaneId("w80:p1N")).toBe(true);

  for (const id of ["", ".", "..", "../x", "a/b", "a\\b", "w1:p1..", "a\u0001b"]) {
    expect(isSafePaneId(id)).toBe(false);
  }
});

test("the note lists the absolute paths under the marker", () => {
  expect(composeAttachedFilesNote(["/state/attachments/w1:p1/a.png"])).toBe(
    "<attached_files>\n- /state/attachments/w1:p1/a.png\n</attached_files>",
  );
});

test("the note is appended after a blank line, and stands alone when the text is empty", () => {
  const paths = ["/state/attachments/w1:p1/a.png"];

  expect(composeInputText("look at this", paths)).toBe(
    "look at this\n\n<attached_files>\n- /state/attachments/w1:p1/a.png\n</attached_files>",
  );
  expect(composeInputText("", paths)).toBe(
    "<attached_files>\n- /state/attachments/w1:p1/a.png\n</attached_files>",
  );
});

test("without paths the text is sent as it is", () => {
  expect(composeInputText("hello", [])).toBe("hello");
  expect(composeInputText("", [])).toBe("");
});

test("stripping the note returns the names under the pane", () => {
  const text = composeInputText("look at this", [
    "/state/attachments/w1:p1/pasted-20261103-120000.png",
    "/state/attachments/w1:p1/pasted-20261103-120000-1.jpg",
  ]);

  expect(stripAttachedFiles(text)).toEqual({
    text: "look at this",
    attachments: ["pasted-20261103-120000.png", "pasted-20261103-120000-1.jpg"],
  });
});

test("a message with only the note keeps its attachments and loses the text", () => {
  const text = composeInputText("", ["/state/attachments/w1:p1/pasted-20261103-120000.png"]);

  expect(stripAttachedFiles(text)).toEqual({
    text: "",
    attachments: ["pasted-20261103-120000.png"],
  });
});

test("text without a note is returned untouched", () => {
  expect(stripAttachedFiles("hello")).toEqual({ text: "hello", attachments: [] });
  expect(stripAttachedFiles("")).toEqual({ text: "", attachments: [] });
  // 閉じが無い・別の本文中にあるだけのものは注記として扱わない。
  expect(stripAttachedFiles("<attached_files>\n- a.png")).toEqual({
    text: "<attached_files>\n- a.png",
    attachments: [],
  });
});

test("only the last note is the one that belongs to the message", () => {
  const text =
    "first\n\n<attached_files>\n- old.png\n</attached_files>\n\nsecond\n\n<attached_files>\n- /state/attachments/w1:p1/pasted-20261103-120000.png\n</attached_files>";

  expect(stripAttachedFiles(text)).toEqual({
    text: "first\n\n<attached_files>\n- old.png\n</attached_files>\n\nsecond",
    attachments: ["pasted-20261103-120000.png"],
  });
});

test("a note without a single valid name is left in the body", () => {
  const text = "hello\n\n<attached_files>\n- /etc/passwd\n</attached_files>";

  expect(stripAttachedFiles(text)).toEqual({ text, attachments: [] });
});
