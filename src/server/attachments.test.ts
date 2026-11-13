import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isStoredAttachmentName } from "../shared/attachments";
import {
  attachmentExists,
  attachmentFilePath,
  defaultAttachmentsRoot,
  defaultStateRoot,
  readAttachment,
  saveAttachment,
} from "./attachments";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hwc-attachments-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

test("saves under the pane and never overwrites a name already taken", async () => {
  const first = await saveAttachment({ root, paneId: "w1:p1", name: "report.zip", bytes: png });
  const second = await saveAttachment({ root, paneId: "w1:p1", name: "report.zip", bytes: png });
  const third = await saveAttachment({ root, paneId: "w1:p1", name: "report.zip", bytes: png });

  expect([first, second, third]).toEqual(["report.zip", "report-1.zip", "report-2.zip"]);
  const bytes = await readAttachment({ root, paneId: "w1:p1", name: first ?? "" });
  expect(new Uint8Array(bytes ?? new ArrayBuffer(0))).toEqual(png);
});

test("a 200-byte name and its numbered sibling are both readable", async () => {
  // 長い末尾を拡張子として予約すると、連番で上限を超えて保存名の検証に落ちる。
  const long = `a.${"b".repeat(198)}`;
  const first = await saveAttachment({ root, paneId: "w1:p1", name: long, bytes: png });
  const second = await saveAttachment({ root, paneId: "w1:p1", name: long, bytes: png });

  expect(first).toBe(long);
  expect(second).not.toBe(first);
  expect(isStoredAttachmentName(second ?? "")).toBe(true);
  expect(await attachmentFilePath(root, "w1:p1", second ?? "")).not.toBeNull();
  expect(await readAttachment({ root, paneId: "w1:p1", name: second ?? "" })).not.toBeNull();
});

test("sanitizes the name and refuses one that has nothing left", async () => {
  expect(
    await saveAttachment({ root, paneId: "w1:p1", name: "../../etc/passwd", bytes: png }),
  ).toBe("etcpasswd");
  expect(await saveAttachment({ root, paneId: "w1:p1", name: "...", bytes: png })).toBeNull();
  expect(await saveAttachment({ root, paneId: "w1:p1", name: ".env", bytes: png })).toBe("env");
});

test("refuses a pane id or a name that would escape the pane directory", async () => {
  expect(await saveAttachment({ root, paneId: "../x", name: "report.zip", bytes: png })).toBeNull();
  expect(attachmentFilePath(root, "../x", "report.zip")).toBeNull();
  expect(attachmentFilePath(root, "w1:p1", "../report.zip")).toBeNull();
  expect(attachmentFilePath(root, "w1:p1", "/etc/passwd")).toBeNull();
});

test("keeps the panes apart", async () => {
  const name =
    (await saveAttachment({ root, paneId: "w1:p1", name: "report.zip", bytes: png })) ?? "";

  expect(await attachmentExists(root, "w1:p1", name)).toBe(true);
  expect(await attachmentExists(root, "w1:p2", name)).toBe(false);
  expect(await readAttachment({ root, paneId: "w1:p2", name })).toBeNull();
});

test("a file that is gone or not a saved name has no bytes", async () => {
  expect(await readAttachment({ root, paneId: "w1:p1", name: "report.zip" })).toBeNull();
  expect(await readAttachment({ root, paneId: "w1:p1", name: "../report.zip" })).toBeNull();
  expect(await attachmentExists(root, "w1:p1", "../report.zip")).toBe(false);
});

test("the root comes from the state dir and ignores a relative path", () => {
  expect(defaultStateRoot({ HWC_STATE_DIR: "/srv/hwc-state" })).toBe("/srv/hwc-state");
  expect(defaultAttachmentsRoot({ HWC_STATE_DIR: "/srv/hwc-state" })).toBe(
    "/srv/hwc-state/attachments",
  );
  // 相対値は作業ディレクトリに依存する。既定へ落とす。
  expect(defaultAttachmentsRoot({ HWC_STATE_DIR: "hwc-state", XDG_STATE_HOME: "/xdg" })).toBe(
    "/xdg/hwc/attachments",
  );
  expect(defaultAttachmentsRoot({ XDG_STATE_HOME: "xdg" })).toBe(
    join(homedir(), ".local", "state", "hwc", "attachments"),
  );
});
