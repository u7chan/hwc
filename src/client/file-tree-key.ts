// ファイルツリーの開閉キー。入力欄にフォーカスがある間は効かせない。送信の後も
// 入力欄にフォーカスが残るので、そこを奪うと打った文字が消える。

export const FILE_TREE_KEY = "f";

type ShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
};

// Shift は許す。Shift+f で F を打つ人が同じ操作に届かなくなる方が困る。
export function isFileTreeShortcut(event: ShortcutEvent): boolean {
  if (event.key.toLowerCase() !== FILE_TREE_KEY) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  // 押しっぱなしで開閉を往復させない。ツリーは閉じると一覧を捨てるので、
  // 連続で開閉すると取得だけが走り続ける。
  if (event.repeat) return false;
  // 変換中のキーは IME のもの。かな入力では最初の 1 打が composition になる。
  return !event.isComposing;
}

// 文字を打つ面にフォーカスがある間は、ツリーの開閉より入力を優先する。
const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTextEntry(element: Element | null): boolean {
  if (element === null) return false;
  if (TEXT_ENTRY_TAGS.has(element.tagName)) return true;
  return element.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

// 開いているダイアログとメニューは、中のキーを自分で決める。閉じる Escape を
// 二重に走らせないのと同じ理由（settings/Settings.tsx）。
export function isInOverlay(element: Element | null): boolean {
  if (element === null) return false;
  return element.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

export type TreeArrowIntent = "next" | "previous" | "expand" | "collapse" | "in" | "out";

// ツリーの中にフォーカスがあるときの矢印キー。上下で行を移り、右で開く／子へ降り、
// 左で閉じる／親へ戻る。修飾キーはブラウザと読み上げに返す。
export function treeArrowIntent(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
  row: { dir: boolean; expanded: boolean },
): TreeArrowIntent | null {
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
  switch (event.key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "ArrowRight":
      return row.dir ? (row.expanded ? "in" : "expand") : null;
    case "ArrowLeft":
      // 閉じているフォルダは親へ戻る。フォルダでなければ常に親へ。
      return row.dir && row.expanded ? "collapse" : "out";
    default:
      return null;
  }
}
