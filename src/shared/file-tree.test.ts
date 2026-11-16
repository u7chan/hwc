import { expect, test } from "bun:test";
import { parseFileTree } from "./file-tree";

test("accepts a file name containing a backslash on POSIX", () => {
  const listing = parseFileTree({
    entries: [
      {
        kind: "file",
        name: "back\\slash.md",
        path: "docs/back\\slash.md",
        open: "text",
        version: "1-2",
      },
    ],
    total: 1,
    truncated: false,
  });

  expect(listing).not.toBeNull();
  expect(listing?.entries[0]).toMatchObject({
    kind: "file",
    name: "back\\slash.md",
    path: "docs/back\\slash.md",
    open: "text",
  });
});

test("rejects a name that contains a path separator", () => {
  expect(
    parseFileTree({
      entries: [{ kind: "file", name: "a/b", path: "a/b", open: "text", version: "1" }],
      total: 1,
      truncated: false,
    }),
  ).toBeNull();
});
