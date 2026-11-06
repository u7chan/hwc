import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { PaneInteraction } from "../shared/confirmation";
import type { PaneClient } from "./herdr/panes";
import type { PaneState } from "./herdr/state";

const DISCLOSURE =
  "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. " +
  "Folder settings can run code automatically, even without a model request. " +
  "Continue only if you trust these files. Your trust decision will be saved.";
const ROOT_WARNING =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";

function fullPath(text: string): boolean {
  // 省略されたパスや折り返しから信頼対象を推測すると、画面に示す承認範囲がずれてしまう。
  const control = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
  return isAbsolute(text) && !control && !text.includes("…") && !text.includes("...");
}

export function parseFolderTrust(text: string): { directory: string } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== "Folder access" || !fullPath(lines[1] ?? "")) return null;
  const selected = lines.indexOf("› 1. Trust and continue");
  if (selected < 2 || lines.slice(2, selected).join(" ") !== DISCLOSURE) return null;
  const cancel = lines[selected + 1];
  const footer = lines[selected + 2];
  if (
    !/^2\. (?:Quit|Back to Agent Command Center|Keep current directory)$/.test(cancel ?? "") ||
    !/^enter continue · esc (?:quit|back|cancel)$/.test(footer ?? "")
  )
    return null;

  const tail = lines.slice(selected + 3);
  if (tail.length === 0) return { directory: lines[1]! };
  const directory = tail.at(-1)!;
  if (tail.slice(0, -1).join(" ") !== ROOT_WARNING || !fullPath(directory)) return null;
  return { directory };
}

function looksLikeFolderTrust(text: string): boolean {
  return /Folder access|Trust this folder\?|Trust and continue|enter continue · esc (?:quit|back|cancel)/.test(
    text,
  );
}

type Observation = { id: string; directory: string; submitted: boolean };

export function createFolderTrust(panes: Pick<PaneClient, "read" | "confirmFolderTrust">) {
  const observations = new Map<string, Observation>();
  const pending = new Map<string, Promise<void>>();

  const serialize = <T>(paneId: string, action: () => Promise<T>): Promise<T> => {
    const result = (pending.get(paneId) ?? Promise.resolve()).then(action);
    const settled = result.then(
      () => {},
      () => {},
    );
    pending.set(paneId, settled);
    void settled.then(() => {
      if (pending.get(paneId) === settled) pending.delete(paneId);
    });
    return result;
  };

  const inspect = async (pane: PaneState): Promise<PaneInteraction | null> => {
    if (pane.agent !== "codex") {
      observations.delete(pane.id);
      return null;
    }
    // recent は過去の確認を含み、visible は端末側のスクロール位置に従う。承認判定は
    // スクリーン検出用の下部バッファだけで行い、全文が読めなければ端末へ逃がす。
    const read = await panes.read({ paneId: pane.id, source: "detection" });
    // 空画面は再描画の途中でも返る。解除とみなすと同じ確認への再送が可能になる。
    if (read.text.trim() === "") return { kind: "terminal" };
    const parsed = read.truncated ? null : parseFolderTrust(read.text);
    if (parsed === null) {
      if (read.truncated || looksLikeFolderTrust(read.text)) return { kind: "terminal" };
      observations.delete(pane.id);
      return null;
    }
    let observation = observations.get(pane.id);
    if (observation?.directory !== parsed.directory) {
      observation = { id: randomUUID(), directory: parsed.directory, submitted: false };
      observations.set(pane.id, observation);
    }
    return {
      kind: "codex-folder-trust",
      id: observation!.id,
      directory: parsed.directory,
      submitted: observation!.submitted,
    };
  };

  return {
    retain(paneIds: readonly string[]) {
      const live = new Set(paneIds);
      for (const id of observations.keys()) {
        if (!live.has(id)) observations.delete(id);
      }
    },
    inspect: (pane: PaneState) => serialize(pane.id, () => inspect(pane)),
    accept: (pane: PaneState, id: string) =>
      serialize(pane.id, async () => {
        const interaction = await inspect(pane);
        if (
          interaction?.kind !== "codex-folder-trust" ||
          interaction.id !== id ||
          interaction.submitted
        ) {
          return "changed" as const;
        }
        // 送信失敗でも、入力が届いたかは分からない。二度目の Enter は別の画面へ入り得るので
        // 同じ確認への自動再送・再クリックは許可せず、端末側での確認に委ねる。
        observations.get(pane.id)!.submitted = true;
        await panes.confirmFolderTrust({ paneId: pane.id });
        return "done" as const;
      }),
  };
}
