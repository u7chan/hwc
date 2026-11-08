import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { supportsFolderTrust, type FolderTrustAgent } from "../shared/agents";
import type { PaneInteraction } from "../shared/confirmation";
import type { PaneClient } from "./herdr/panes";
import type { PaneState } from "./herdr/state";

const CODEX_DISCLOSURE =
  "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. " +
  "Folder settings can run code automatically, even without a model request. " +
  "Continue only if you trust these files. Your trust decision will be saved.";
const CODEX_ROOT_WARNING =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";

const PI_TITLE = "Trust project folder?";
const PI_DISCLOSURE =
  "This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.";
const PI_FOOTER = "↑↓ navigate  enter select  escape/ctrl+c cancel";
const PI_PARENT = /^Trust parent folder \((.+)\)$/;

function fullPath(text: string): boolean {
  // 省略されたパスや折り返しから信頼対象を推測すると、画面に示す承認範囲がずれてしまう。
  const control = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
  return isAbsolute(text) && !control && !text.includes("…") && !text.includes("...");
}

// 端末幅で折り返された本文を、行数に依存せず 1 行として比べる。
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseCodexFolderTrust(text: string): { directory: string } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== "Folder access" || !fullPath(lines[1] ?? "")) return null;
  const selected = lines.indexOf("› 1. Trust and continue");
  if (selected < 2 || lines.slice(2, selected).join(" ") !== CODEX_DISCLOSURE) return null;
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
  if (tail.slice(0, -1).join(" ") !== CODEX_ROOT_WARNING || !fullPath(directory)) return null;
  return { directory };
}

function parsePiProjectTrust(text: string): { directory: string } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^─+$/.test(line));
  // 過去の出力が上に残った画面を承認しない。起動直後の確認は画面の先頭に出る。
  if (lines[0] !== PI_TITLE) return null;
  const directory = lines[1] ?? "";
  if (!fullPath(directory)) return null;

  const selected = lines.indexOf("→ Trust");
  // 選択中の文言をそのまま比べる。既定は「Trust」で、それ以外は端末での操作に任せる。
  if (selected < 2 || lines.findIndex((line) => line.startsWith("→ ")) !== selected) return null;
  if (oneLine(lines.slice(2, selected).join(" ")) !== PI_DISCLOSURE) return null;

  const tail = lines.slice(selected + 1);
  if (oneLine(tail.at(-1) ?? "") !== oneLine(PI_FOOTER)) return null;
  const options = tail.slice(0, -1);
  if (options.length < 4) return null;
  if (options.at(-1) !== "Do not trust (this session only)") return null;
  if (options.at(-2) !== "Do not trust") return null;
  if (options.at(-3) !== "Trust (this session only)") return null;
  // 親フォルダの選択肢は cwd とは別の場所を指す。信頼対象は cwd だけなので、形だけを確かめる。
  const parent = PI_PARENT.exec(oneLine(options.slice(0, -3).join(" ")));
  if (parent === null || !fullPath(parent[1]!)) return null;

  return { directory };
}

export function parseFolderTrust(
  agent: FolderTrustAgent,
  text: string,
): { directory: string } | null {
  return agent === "codex" ? parseCodexFolderTrust(text) : parsePiProjectTrust(text);
}

const CODEX_HINTS =
  /Folder access|Trust this folder\?|Trust and continue|enter continue · esc (?:quit|back|cancel)/;
// フッターの `↑↓ navigate` は Pi の選択ダイアログ全般に付く。これだけで確認とみなすと、
// 会話やツール出力に含まれた通常のペインまで入力欄を閉じてしまう。
const PI_TITLE_HINT = /Trust project folder\?/;
const PI_OPTION_HINT =
  /Trust parent folder \(|Trust \(this session only\)|Do not trust \(this session only\)/;

function looksLikeFolderTrust(agent: FolderTrustAgent, text: string): boolean {
  return agent === "codex"
    ? CODEX_HINTS.test(text)
    : PI_TITLE_HINT.test(text) && PI_OPTION_HINT.test(text);
}

type Observation = { id: string; agent: FolderTrustAgent; directory: string; submitted: boolean };

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
    if (!supportsFolderTrust(pane.agent)) {
      observations.delete(pane.id);
      return null;
    }
    // recent は過去の確認を含み、visible は端末側のスクロール位置に従う。承認判定は
    // スクリーン検出用のバッファだけで行い、全文が読めなければ端末へ逃がす。
    const read = await panes.read({ paneId: pane.id, source: "detection" });
    // 空画面は再描画の途中でも返る。解除とみなすと同じ確認への再送が可能になる。
    if (read.text.trim() === "") return { kind: "terminal" };
    const parsed = read.truncated ? null : parseFolderTrust(pane.agent, read.text);
    if (parsed === null) {
      if (read.truncated || looksLikeFolderTrust(pane.agent, read.text))
        return { kind: "terminal" };
      observations.delete(pane.id);
      return null;
    }
    let observation = observations.get(pane.id);
    if (observation?.agent !== pane.agent || observation.directory !== parsed.directory) {
      observation = {
        id: randomUUID(),
        agent: pane.agent,
        directory: parsed.directory,
        submitted: false,
      };
      observations.set(pane.id, observation);
    }
    return {
      kind: "folder-trust",
      id: observation!.id,
      agent: pane.agent,
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
          interaction?.kind !== "folder-trust" ||
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
