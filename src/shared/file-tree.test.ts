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

test("keeps the gitignored mark and drops anything else", () => {
  const listing = parseFileTree({
    entries: [
      { kind: "dir", name: "node_modules", path: "node_modules", expandable: true, ignored: true },
      { kind: "file", name: "a.md", path: "a.md", open: "text", version: "1", ignored: "yes" },
    ],
    total: 2,
    truncated: false,
  });

  expect(listing?.entries[0]).toMatchObject({ ignored: true });
  expect(listing?.entries[1]).not.toHaveProperty("ignored");
});
