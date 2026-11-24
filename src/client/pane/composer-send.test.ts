import { expect, test } from "bun:test";
import type { AttachedFile } from "../attachment-store";
import { composerSend } from "./composer-send";

const attachment = (name: string | null, size = 10): AttachedFile => ({
  key: name ?? "uploading",
  name,
  size,
  controller: new AbortController(),
});

test("the draft is sent as written, with the names of the saved attachments", () => {
  const send = composerSend({
    kind: "draft",
    draft: "look at this",
    attachments: [attachment("a.png", 3), attachment(null), attachment("b.txt", 5)],
  });

  expect(send).toEqual({ text: "look at this", names: ["a.png", "b.txt"] });
});

test("a draft without attachments carries no names", () => {
  expect(composerSend({ kind: "draft", draft: "", attachments: [] })).toEqual({
    text: "",
    names: [],
  });
});

test("the chip sends the command and never the attachments", () => {
  expect(composerSend({ kind: "chip", id: "new", draft: "half written" })).toEqual({
    text: "/new",
    names: [],
  });
  expect(composerSend({ kind: "chip", id: "compact", draft: "shorten\n  the tail " })).toEqual({
    text: "/compact shorten the tail",
    names: [],
  });
});

test("a chip without a draft sends the bare command", () => {
  expect(composerSend({ kind: "chip", id: "compact", draft: "   " })).toEqual({
    text: "/compact",
    names: [],
  });
});

test("the menu item sends the command string on its own", () => {
  expect(composerSend({ kind: "menu", id: "new" })).toEqual({ text: "/new", names: [] });
  expect(composerSend({ kind: "menu", id: "compact" })).toEqual({ text: "/compact", names: [] });
});
