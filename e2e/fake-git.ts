import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// 実リポジトリ・実リモートには触れない。BFF が読む `remote` / `for-each-ref` と、
// メニューから呼ぶ `fetch` / `pull --ff-only`、プロジェクト候補の `ls-files` だけを、
// fixture の状態に対して返す。
type Entry = {
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
};

type State = Record<string, Entry>;

const statePath = process.env.HWC_E2E_GIT_STATE;
if (statePath === undefined) process.exit(2);

const cwd = process.cwd();
const args = process.argv.slice(2);

function readState(): State {
  return JSON.parse(readFileSync(statePath!, "utf8")) as State;
}

function track(entry: Entry): string {
  const parts: string[] = [];
  if (entry.ahead > 0) parts.push(`ahead ${entry.ahead}`);
  if (entry.behind > 0) parts.push(`behind ${entry.behind}`);
  return parts.length === 0 ? "" : `[${parts.join(", ")}]`;
}

const state = readState();
const entry = state[cwd];

// プロジェクト候補の走査結果。実ファイルを作らず、モノレポの形だけを返す。
const dashboard = join(dirname(statePath), "work", "acme-dashboard");
const projectFiles: Record<string, string[]> = {
  [dashboard]: [
    "package.json",
    "packages/api/package.json",
    "packages/web/pyproject.toml",
    "apps/desktop/Cargo.toml",
  ],
};

switch (args[0]) {
  case "remote":
    if (entry?.hasRemote === true) process.stdout.write("origin\n");
    process.exit(0);
  case "for-each-ref":
    if (entry?.upstream != null) {
      process.stdout.write(`${entry.upstream}\t${track(entry)}\n`);
    }
    process.exit(0);
  case "fetch":
    process.exit(entry === undefined ? 2 : 0);
  case "pull":
    if (args[1] !== "--ff-only" || entry === undefined) process.exit(2);
    // fast-forward したことにする。次の状態公開で behind が 0 になる。
    entry.behind = 0;
    writeFileSync(statePath!, JSON.stringify(state, null, 2));
    process.exit(0);
  case "ls-files":
    process.stdout.write((projectFiles[cwd] ?? []).join("\0"));
    process.exit(0);
  default:
    process.exit(2);
}
