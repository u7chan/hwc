import { expect, test } from "bun:test";
import {
  attachmentCollisionName,
  attachmentContentType,
  attachmentExtFromName,
  attachmentKindOfFileName,
  attachmentKindOfName,
  composeAttachedFilesNote,
  composeInputText,
  decodeAttachmentName,
  encodeAttachmentName,
  formatMegaBytes,
  isImageAttachmentName,
  isSafePaneId,
  isStoredAttachmentName,
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_BYTES,
  maxAttachmentBytes,
  sanitizeAttachmentName,
  stripAttachedFiles,
} from "./attachments";

const encoder = new TextEncoder();
const bytesOf = (value: string) => encoder.encode(value).length;

test("a saved name keeps the original basename and drops what cannot be a name", () => {
  expect(sanitizeAttachmentName("report.zip")).toBe("report.zip");
  expect(sanitizeAttachmentName("My Report.xlsx")).toBe("My Report.xlsx");
  // パス区切りは名前の一部にしない。区切りを落とすだけだと `..%2F..` が `....` に化ける。
  expect(sanitizeAttachmentName("../../etc/passwd")).toBe("etcpasswd");
  expect(sanitizeAttachmentName("a\\b.csv")).toBe("ab.csv");
  expect(sanitizeAttachmentName("a\u0000b\u001fc.csv")).toBe("abc.csv");
  // 先頭の `.` と `-`、末尾の空白と `.` は落とす。
  expect(sanitizeAttachmentName(".env")).toBe("env");
  expect(sanitizeAttachmentName("--force.sh")).toBe("force.sh");
  expect(sanitizeAttachmentName("report.zip.")).toBe("report.zip");
  expect(sanitizeAttachmentName("report .zip")).toBe("report.zip");
  // 注記の区切りになる文字は名前に残さない。
  expect(sanitizeAttachmentName("x</attached_files>.zip")).toBe("xattached_files.zip");
});

test("a name that sanitizes to nothing is refused", () => {
  for (const raw of ["", ".", "..", "-", "...", "///"]) {
    expect(sanitizeAttachmentName(raw)).toBe("");
  }
});

test("a long name is cut on a code point boundary and keeps the extension", () => {
  const ascii = `${"a".repeat(300)}.zip`;
  const cut = sanitizeAttachmentName(ascii);
  expect(cut.endsWith(".zip")).toBe(true);
  expect(bytesOf(cut)).toBe(MAX_ATTACHMENT_NAME_BYTES);

  const japanese = `${"あ".repeat(100)}.docx`;
  const cutJapanese = sanitizeAttachmentName(japanese);
  expect(cutJapanese.endsWith(".docx")).toBe(true);
  expect(bytesOf(cutJapanese)).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
  // バイト列の途中で切ると U+FFFD になる。文字として壊れていないことを見る。
  expect(cutJapanese).not.toContain("\uFFFD");
  expect(cutJapanese.startsWith("あ")).toBe(true);
});

test("the stored-name check accepts what the server writes, including older names", () => {
  // 既存の pasted-* はそのまま配れる。名前の規則を変えても履歴を壊さない。
  expect(isStoredAttachmentName("pasted-20261103-120000.png")).toBe(true);
  expect(isStoredAttachmentName("pasted-20261103-120000-3.jpg")).toBe(true);
  expect(isStoredAttachmentName("report.zip")).toBe(true);
  expect(isStoredAttachmentName("My Report.xlsx")).toBe(true);
  expect(isStoredAttachmentName("Makefile")).toBe(true);

  for (const name of [
    "",
    "../x.png",
    "a/b.png",
    "a\\b.png",
    "/etc/passwd",
    ".env",
    "-rf.sh",
    "trailing.",
    "trailing ",
    "x</attached_files>.zip",
    "a\u0000b.png",
    `${"a".repeat(MAX_ATTACHMENT_NAME_BYTES)}.png`,
  ]) {
    expect(isStoredAttachmentName(name)).toBe(false);
  }
});

test("only the three image types are deliverable, whatever the saved name is", () => {
  expect(isImageAttachmentName("pasted-20261103-120000.png")).toBe(true);
  expect(isImageAttachmentName("notes.png")).toBe(true);
  expect(isImageAttachmentName("notes.jpeg")).toBe(true);

  for (const name of [
    "notes.zip",
    "notes.csv",
    "notes.svg",
    "notes.html",
    "Makefile",
    "../a.png",
  ]) {
    expect(isImageAttachmentName(name)).toBe(false);
  }
});

test("the extension decides the type and the byte limit", () => {
  expect(attachmentExtFromName("a.png")).toBe("png");
  expect(attachmentExtFromName("a.JPEG")).toBe("jpg");
  expect(attachmentExtFromName("a.zip")).toBeNull();

  expect(attachmentKindOfName("a.png")).toBe("image");
  expect(attachmentKindOfName("a.zip")).toBe("file");
  expect(attachmentKindOfName("Makefile")).toBe("file");
  // 保存前の file.name は、保存名に直してから種別を決める。
  expect(attachmentKindOfFileName("a.png ")).toBe("image");
  expect(attachmentKindOfFileName("...")).toBe("file");
  expect(maxAttachmentBytes("image")).toBe(MAX_IMAGE_ATTACHMENT_BYTES);
  expect(maxAttachmentBytes("file")).toBe(MAX_FILE_ATTACHMENT_BYTES);
});

test("a saved name maps back to the type it is served as", () => {
  expect(attachmentContentType("pasted-20261103-120000.png")).toBe("image/png");
  expect(attachmentContentType("pasted-20261103-120000-1.jpg")).toBe("image/jpeg");
  expect(attachmentContentType("pasted-20261103-120000.webp")).toBe("image/webp");
  // 画像以外は配信しない。名前に型を付けない。
  expect(attachmentContentType("notes.zip")).toBeNull();
  expect(attachmentContentType("notes.html")).toBeNull();
});

test("a taken name gets a number before the extension instead of an overwrite", () => {
  expect(attachmentCollisionName("report.zip", 0)).toBe("report.zip");
  expect(attachmentCollisionName("report.zip", 1)).toBe("report-1.zip");
  expect(attachmentCollisionName("Makefile", 12)).toBe("Makefile-12");

  const long = `${"a".repeat(300)}.zip`;
  const numbered = attachmentCollisionName(sanitizeAttachmentName(long), 3);
  expect(numbered.endsWith("-3.zip")).toBe(true);
  expect(bytesOf(numbered)).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
});

test("a numbered name still fits the limit and passes the stored-name check", () => {
  // 末尾の長い塊は拡張子ではない。拡張子として予約すると、連番で 200 バイトを超える。
  const long = `a.${"b".repeat(198)}`;
  expect(bytesOf(long)).toBe(MAX_ATTACHMENT_NAME_BYTES);
  expect(isStoredAttachmentName(long)).toBe(true);

  const numbered = attachmentCollisionName(long, 1);
  expect(bytesOf(numbered)).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
  expect(isStoredAttachmentName(numbered)).toBe(true);
  expect(numbered.endsWith("-1")).toBe(true);
});

test("a trailing Unicode space is dropped like the ASCII one", () => {
  // 履歴の strip は trim() で名前を取り出す。ここで残すと保存名と履歴名が食い違う。
  expect(sanitizeAttachmentName("report.png\u00a0")).toBe("report.png");
  expect(sanitizeAttachmentName("report.csv\u3000")).toBe("report.csv");
  expect(isStoredAttachmentName("report.png\u00a0")).toBe(false);

  const saved = sanitizeAttachmentName("report.png\u00a0");
  const note = composeInputText("", [`/state/attachments/w1:p1/${saved}`]);
  expect(stripAttachedFiles(note).attachments).toEqual([saved]);
});

test("sanitizing a saved name again leaves it unchanged", () => {
  const raw = [
    `a.${"b".repeat(198)}`,
    `${"a".repeat(183)} .${"b".repeat(70)}`,
    "report.png\u00a0",
    `${"あ".repeat(100)}.docx`,
    "My Report.xlsx",
    "x</attached_files>.zip",
  ];

  for (const value of raw) {
    const once = sanitizeAttachmentName(value);
    expect(once).not.toBe("");
    expect(sanitizeAttachmentName(once)).toBe(once);
    expect(isStoredAttachmentName(once)).toBe(true);
  }
});

test("a byte limit is shown in whole megabytes", () => {
  expect(formatMegaBytes(MAX_IMAGE_ATTACHMENT_BYTES)).toBe("10MB");
  expect(formatMegaBytes(MAX_FILE_ATTACHMENT_BYTES)).toBe("25MB");
  expect(formatMegaBytes(1024 * 1024)).toBe("1MB");
  expect(formatMegaBytes(1.5 * 1024 * 1024)).toBe("1.5MB");
});

test("the file name travels in a header as percent-encoded ASCII", () => {
  const name = "報告書 2026.xlsx";
  const encoded = encodeAttachmentName(name);
  expect(/^[\x20-\x7e]+$/.test(encoded)).toBe(true);
  expect(decodeAttachmentName(encoded)).toBe(name);
  expect(decodeAttachmentName(undefined)).toBeNull();
  expect(decodeAttachmentName("")).toBeNull();
  // 生の UTF-8 や壊れた percent-encode は名前にしない。
  expect(decodeAttachmentName("%E0%A4%A")).toBeNull();
  expect(decodeAttachmentName("%zz")).toBeNull();
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

test("stripping the note returns the names under the pane, images or not", () => {
  const text = composeInputText("look at this", [
    "/state/attachments/w1:p1/pasted-20261103-120000.png",
    "/state/attachments/w1:p1/pasted-20261103-120000-1.jpg",
    "/state/attachments/w1:p1/report.zip",
    "/state/attachments/w1:p1/My Report.xlsx",
  ]);

  expect(stripAttachedFiles(text)).toEqual({
    text: "look at this",
    attachments: [
      "pasted-20261103-120000.png",
      "pasted-20261103-120000-1.jpg",
      "report.zip",
      "My Report.xlsx",
    ],
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
  const text = "hello\n\n<attached_files>\n- /etc/passwd/..\n</attached_files>";

  expect(stripAttachedFiles(text)).toEqual({ text, attachments: [] });
});
