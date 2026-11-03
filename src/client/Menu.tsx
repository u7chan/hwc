import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";

// メニューはトリガーの下に出す。画面の端では、はみ出す分だけ内側へ寄せる。
export const MENU_GAP = 4;
export const MENU_MARGIN = 8;
// .hwc-menu の min-width。実際の幅は文言で変わるが、はみ出しの判定にはこれで足りる。
export const MENU_MIN_WIDTH = 220;
// 見出しと項目 1 つ分の目安。高さは項目数で決まるので、呼び出し側が渡す。
export const MENU_HEIGHT = 96;

// rect はトリガーの矩形（getBoundingClientRect）。right は画面の右端からの距離で返す。
export type MenuPlacement = { top: number; right: number };

export function menuPlacement(
  rect: { bottom: number; right: number },
  viewport: { width: number; height: number },
  height: number,
): MenuPlacement {
  const top = Math.max(
    MENU_MARGIN,
    Math.min(rect.bottom + MENU_GAP, viewport.height - height - MENU_MARGIN),
  );
  const right = Math.max(
    0,
    Math.min(viewport.width - rect.right, viewport.width - MENU_MIN_WIDTH - MENU_MARGIN),
  );
  return { top, right };
}

type MenuProps = {
  label: string;
  placement: MenuPlacement;
  onClose: () => void;
  children: ComponentChildren;
};

// 行き場のない場所・Esc・スクロール・画面の伸縮で閉じる。中身は画面ごとに差し替える。
export function Menu(props: MenuProps) {
  const { onClose } = props;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const close = () => onClose();
    window.addEventListener("keydown", onKey);
    // 中身が動くとトリガーとの位置がずれる。capture で内側のスクロールも拾う。
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  return (
    <>
      <div class="hwc-menu-backdrop" onPointerDown={onClose} />
      <div
        class="hwc-menu"
        role="menu"
        aria-label={props.label}
        style={{ top: `${props.placement.top}px`, right: `${props.placement.right}px` }}
      >
        {props.children}
      </div>
    </>
  );
}
