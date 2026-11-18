import { insertAtSelection, type Insertion } from "./input";

// ツリーの行を入力欄へ運ぶときの DataTransfer の型。dragover では getData を読めない
// （保護モード）ので、受け入れるかどうかは型だけで決める。
export const FILE_REFERENCE_TYPE = "application/x-hwc-file-reference";

// プレビューの「パスをコピー」と、ツリーからのドロップで同じ文字列を入れる。
// ツリーの根はスペースのチェックアウトで、ペインの cwd とは限らない。エージェントは
// `./` を cwd から解決するため、根からの相対パスを `./` で入れると、cwd がサブ
// ディレクトリのペインで静かに別のファイルを指す（ADR 0056 / 0095）。
export function fileReference(
  workspacePath: string | null,
  path: string,
  directory: boolean,
): string {
  const base = workspacePath === null ? path : `${workspacePath}/${path}`;
  return directory ? `${base}/` : base;
}

export type ReferenceInsertion = Insertion;

// 選択範囲を置き換え、前後の語とくっつかないよう必要なら空白を足す。
export function insertFileReference(
  draft: string,
  start: number,
  end: number,
  reference: string,
): ReferenceInsertion {
  // 入力欄を離れてから落とすので、選択範囲は前の下書きのものかもしれない。
  const from = Math.max(0, Math.min(start, end, draft.length));
  const to = Math.max(0, Math.min(Math.max(start, end), draft.length));
  return insertAtSelection(draft, from, to, reference);
}
