// Herdr が管理しないスペースは worktree 情報を持たないか、git から補った表示用の
// 情報だけを持つ。同じ場所を指す複数のスペースを見分けるには、表示名ではなく
// チェックアウトのパスを使う。
export type PlaceCandidate = {
  label: string;
  path?: string | null;
  // Herdr がワークツリーとして登録しているか。表示用に git から補っただけの
  // worktree 情報（managed: false）は、ネイティブスペースとして扱う。
  worktree: { managed?: boolean } | null;
};

export type Place = {
  key: string;
  path: string;
  label: string;
};

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = cut >= 0 ? path.slice(cut + 1) : path;
  return name === "" ? path : name;
}

// 同じパス・同じラベルのときだけ同じ場所とみなす。ラベルだけでは、既定の
// ディレクトリ名が同じ別の場所を混ぜる。パスだけでは、同じチェックアウトを
// 別名で使い分ける意図を潰す。Herdr が管理するワークツリーはリポジトリ束が扱う。
export function placeOf(workspace: PlaceCandidate): Place | null {
  if (workspace.worktree?.managed === true) return null;
  const rawPath = workspace.path?.trim() ?? "";
  if (rawPath === "") return null;
  const path = normalizePath(rawPath);
  const label = workspace.label.trim();
  return {
    key: `place:${encodeURIComponent(path)}:${encodeURIComponent(label)}`,
    path,
    label: label === "" ? basename(path) : label,
  };
}
