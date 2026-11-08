// 実 gh は認証済みのアカウントで実リポジトリへ問い合わせる。E2E ではブランチごとの
// 架空の PR だけを返し、それ以外のサブコマンドは失敗させる。
const PULL_REQUESTS: Record<
  string,
  { number: number; url: string; title: string; state: "OPEN" | "MERGED" | "CLOSED" }
> = {
  "feat/empty-state": {
    number: 481,
    url: "https://github.com/example/acme-dashboard/pull/481",
    title: "Add an empty state to the dashboard",
    state: "OPEN",
  },
  // merge 後も概要は残し、チップだけを消すことを確かめる。
  "docs/quickstart": {
    number: 482,
    url: "https://github.com/example/acme-dashboard/pull/482",
    title: "Write the quickstart guide",
    state: "MERGED",
  },
};

const args = process.argv.slice(2);
if (args[0] !== "pr" || args[1] !== "list") process.exit(2);

const head = args.indexOf("--head");
const branch = head >= 0 ? args[head + 1] : null;
if (branch === null || branch === "") process.exit(2);

const pullRequest = PULL_REQUESTS[branch];
process.stdout.write(`${JSON.stringify(pullRequest === undefined ? [] : [pullRequest])}\n`);
