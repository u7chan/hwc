// モデルやユーザーが書いた文字列を、1 行の表示・送信用に揃える。制御文字を落として改行と
// タブを空白にし、連続する空白を 1 つにして前後を削る。Markdown や HTML は解釈しない。
export function flatText(value: string): string {
  return value
    .replace(/\p{Cc}/gu, (char) => (/[\n\r\t]/.test(char) ? " " : ""))
    .replace(/ {2,}/g, " ")
    .trim();
}
