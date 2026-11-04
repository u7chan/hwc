// タブ内に作れるペインの上限。狭いペインは TUI の幅に依存する UI（承認ダイアログなど）を
// 壊すので、hwc から増やせる枚数を 2x2 までに抑える。
export const MAX_PANES_PER_TAB = 4;
