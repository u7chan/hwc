import { expect, test } from "bun:test";
import { placeOf } from "./place";

test("the same path and label make the same place", () => {
  const first = placeOf({ label: "mypi", path: "/work/mypi", worktree: null });
  const second = placeOf({ label: "mypi", path: "/work/mypi/", worktree: null });

  expect(first).toEqual({ key: "place:%2Fwork%2Fmypi:mypi", path: "/work/mypi", label: "mypi" });
  expect(second?.key).toBe(first?.key);
});

test("a different label keeps the same path apart", () => {
  const first = placeOf({ label: "mypi", path: "/work/mypi", worktree: null });
  const second = placeOf({ label: "mypi review", path: "/work/mypi", worktree: null });

  expect(first?.key).not.toBe(second?.key);
});

test("a different path keeps the same label apart", () => {
  const first = placeOf({ label: "mypi", path: "/work/mypi", worktree: null });
  const second = placeOf({ label: "mypi", path: "/work/other/mypi", worktree: null });

  expect(first?.key).not.toBe(second?.key);
});

test("a workspace managed as a worktree is not a native place", () => {
  expect(
    placeOf({
      label: "mypi",
      path: "/work/mypi-wt",
      worktree: { managed: true },
    }),
  ).toBeNull();
});

test("display-only worktree information does not stop place grouping", () => {
  expect(
    placeOf({
      label: "mypi",
      path: "/work/mypi",
      worktree: { managed: false },
    }),
  ).toEqual({ key: "place:%2Fwork%2Fmypi:mypi", path: "/work/mypi", label: "mypi" });
});

test("a workspace without a path cannot be identified", () => {
  expect(placeOf({ label: "mypi", worktree: null })).toBeNull();
  expect(placeOf({ label: "mypi", path: "  ", worktree: null })).toBeNull();
});

test("an empty label falls back to the directory name", () => {
  expect(placeOf({ label: "", path: "/work/mypi/", worktree: null })?.label).toBe("mypi");
});

test("the key keeps characters that cannot be used in a DOM id escaped", () => {
  const place = placeOf({ label: "a b", path: "/work/a b", worktree: null });

  expect(place?.key).toBe("place:%2Fwork%2Fa%20b:a%20b");
  expect(place?.key).not.toContain(" ");
  expect(place?.key).not.toContain("/");
});
