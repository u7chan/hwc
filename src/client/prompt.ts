export type ShellPrompt = {
  // user@host。入力の上に、どこで動いているかの目印として出す。
  user: string | null;
  // ユーザー名を除いた残り。作業ディレクトリなど、環境によって中身が変わる。
  path: string;
  // 行末の記号。入力の直前に置く。
  mark: string;
};

const MARKS = ["❯", "$", "#", "%", ">"] as const;
const USER_HOST = /^(\S+@\S+):(.*)$/;

// これを超える行はプロンプトではなく出力とみなす。長い行を入力の前に出しても読めない。
const MAX_LENGTH = 120;

export function parsePrompt(output: string | null): ShellPrompt | null {
  if (output === null) return null;

  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].replace(/\s+$/, "");
    if (line === "") continue;
    if (line.length > MAX_LENGTH) return null;

    const mark = MARKS.find((candidate) => line.endsWith(candidate));
    if (mark === undefined) return null;

    const text = line.slice(0, -mark.length).replace(/\s+$/, "");
    const match = USER_HOST.exec(text);
    if (match === null) return { user: null, path: text, mark };
    return { user: match[1], path: match[2], mark };
  }

  return null;
}
