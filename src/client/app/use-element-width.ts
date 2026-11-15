import { useLayoutEffect, useRef, useState } from "preact/hooks";

// 幅で出し分ける部品は、ウィンドウではなく実際に使える幅で決める。ペイン一覧の幅は
// 利用者が変えられるので、メディアクエリだけでは足りない。
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const update = () => {
      const next = element.clientWidth;
      setWidth((current) => (current === next ? current : next));
    };

    // 最初の 1 回は描画前に測る。出し分けが遅れると、広い画面で一瞬だけ別の形が見える。
    update();

    // 監視中の再計測は次のフレームへ送る。同じフレームで幅を変えると、ブラウザが
    // "ResizeObserver loop" として警告する。
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(element);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return { ref, width };
}
