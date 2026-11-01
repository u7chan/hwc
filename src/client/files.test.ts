import { expect, test } from "bun:test";
import { addAttachments, formatBytes, removeAttachment, toAttachment } from "./files";

test("formatBytes keeps small sizes readable", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(-5)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.0 KB");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(160 * 1024)).toBe("160 KB");
  expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
  expect(formatBytes(42 * 1024 * 1024)).toBe("42 MB");
});

test("an attachment keeps the parts the list shows", () => {
  expect(toAttachment({ name: "shot.png", size: 2048, lastModified: 1700000000 })).toEqual({
    id: "shot.png:2048:1700000000",
    name: "shot.png",
    size: 2048,
  });
});

test("dropping the same file twice adds it once", () => {
  const file = { name: "shot.png", size: 2048, lastModified: 1700000000 };
  const once = addAttachments([], [file]);
  const twice = addAttachments(once, [file]);

  expect(twice).toHaveLength(1);
  expect(twice[0].name).toBe("shot.png");
});

test("the same name with a different size is kept", () => {
  const first = addAttachments([], [{ name: "a.log", size: 1, lastModified: 1 }]);
  const second = addAttachments(first, [{ name: "a.log", size: 2, lastModified: 1 }]);

  expect(second.map((item) => item.size)).toEqual([1, 2]);
});

test("attachments stop at the limit", () => {
  const files = Array.from({ length: 12 }, (_, index) => ({
    name: `f${index}.txt`,
    size: index + 1,
    lastModified: 1,
  }));
  const attachments = addAttachments([], files);

  expect(attachments).toHaveLength(10);
  expect(attachments.at(-1)?.name).toBe("f9.txt");
});

test("removing an attachment keeps the order of the rest", () => {
  const files = [
    { name: "a.txt", size: 1, lastModified: 1 },
    { name: "b.txt", size: 2, lastModified: 1 },
  ];
  const attachments = addAttachments([], files);

  expect(removeAttachment(attachments, attachments[0].id).map((item) => item.name)).toEqual([
    "b.txt",
  ]);
});
