// iOS の Safari は、タッチで開いたメニューやダイアログがプログラムでフォーカスを移すと、
// :focus-visible の輪郭を残すことがある。ブラウザの判定だけに任せず、最後の入力手段を持つ。
export type InputModality = "pointer" | "mouse" | "keyboard";

export function installInputModality(): void {
  const root = document.documentElement;
  // 主ポインタが粗い端末では、初期表示のプログラム的フォーカスにも輪郭を出さない。
  root.dataset.inputModality = window.matchMedia("(pointer: coarse)").matches ? "pointer" : "mouse";

  const set = (modality: InputModality) => {
    if (root.dataset.inputModality !== modality) root.dataset.inputModality = modality;
  };
  const pointer = (event: PointerEvent) => {
    // マウスはブラウザの :focus-visible に任せる。タッチとペンだけ輪郭を消す。
    const touch = event.pointerType === "touch" || event.pointerType === "pen";
    set(touch ? "pointer" : "mouse");
  };
  const keyboard = () => set("keyboard");

  document.addEventListener("pointerdown", pointer, { capture: true, passive: true });
  document.addEventListener("keydown", keyboard, true);
}

export function isKeyboardInput(): boolean {
  return document.documentElement.dataset.inputModality === "keyboard";
}
