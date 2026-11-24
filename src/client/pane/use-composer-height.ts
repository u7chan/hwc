import type { RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { type HeightInput, heightInputAt, needsFit } from "./composer-height";

type ComposerHeightOptions = {
  // 簡略表示か。折り返したときに、入力欄を読み幅いっぱいへ広げるかの判断に使う。
  compact: boolean;
  // 入力欄を閉じているか。閉じたときの高さへ戻すきっかけになる。
  inputDisabled: boolean;
};

export type ComposerHeight = {
  // 入力欄。高さを測る effect と useComposer が同じ要素を使う。
  field: RefObject<HTMLTextAreaElement | null>;
  // 引用や挿入のあと、再描画された入力欄へ戻すキャレット。useComposer が書く。
  pendingCaret: RefObject<number | null>;
  // 広げているか。簡略表示では効かせない。
  expanded: boolean;
  // 中身に合わせて高さを合わせる。useComposer も送信や貼り付けのあとに呼ぶ。
  fit: (field: HTMLTextAreaElement | null, open: boolean) => void;
  // 入力欄の開閉。押した時点の高さを、開閉後の高さへ動かす始点にする。
  toggle: () => void;
};

// 入力欄の高さは描画の前に合わせる。描画の後に合わせると、改行した 1 フレームだけ箱が
// 低いままになり、スクロールバーが一瞬出る（iOS では入力欄が跳ねる）。useEffect に
// 変えず、useLayoutEffect のままにする。
export function useComposerHeight(options: ComposerHeightOptions): ComposerHeight {
  const { compact, inputDisabled } = options;
  const field = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  // 開閉を押した時点の入力欄の高さ。開閉後の高さへ動かす始点にする。
  const toggleFrom = useRef<number | null>(null);
  // 実行中の開閉アニメーション。高さを測る前に止める。
  const heightAnimation = useRef<Animation | null>(null);
  // 最後に測ったときの条件。測り直すかは needsFit が決める。
  const measured = useRef<HeightInput | null>(null);
  const [expandedOpen, setExpandedOpen] = useState(false);
  // 簡略中は expanded を効かせない。状態は書き換えないので、通常の高さに戻れば再び効く。
  const expanded = expandedOpen && !compact;

  // 入力量に合わせて高さを伸ばす。広げている間は CSS の高さに任せる。
  // 簡略表示では入力欄と情報・送信を同じ行に置くが、折り返して 2 行以上になったら
  // 入力欄を読み幅いっぱいに広げたい。広い幅で 1 行に戻ると狭い幅で再び折り返し、
  // 行の往復が起きるので、空にするまで広い側を保つ。
  const fit = (target: HTMLTextAreaElement | null, open: boolean) => {
    if (!target) return;
    // アニメーション中の rect と scrollHeight は途中の高さになる。計測の前に止める。
    heightAnimation.current?.cancel();
    heightAnimation.current = null;
    const form = target.closest(".hwc-input");
    target.style.height = "";
    if (open) {
      form?.removeAttribute("data-wrapped");
      return;
    }
    target.style.height = "auto";
    const style = getComputedStyle(target);
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    const oneLine = Math.max(
      line + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
      Number.parseFloat(style.minHeight) || 0,
    );
    if (compact && target.value !== "" && target.scrollHeight > oneLine + 1) {
      form?.setAttribute("data-wrapped", "");
    } else if (!compact || target.value === "") {
      form?.removeAttribute("data-wrapped");
    }
    // 属性を変えると入力欄の幅も変わるので、その後の高さで合わせる。
    target.style.height = `${target.scrollHeight}px`;
  };

  // 送信で空にしたときも、高さを初期状態へ戻す。分割枚数が変わって簡略が切り替わった
  // ときも、前の inline height を残さない。本文は useComposer が持ち、この hook より
  // 後に作られるので deps に取れない。代わりに描画の後で入力欄の値と前回の条件を比べ、
  // 変わったときだけ測り直す（毎描画で測ると、走っているアニメーションを止めてしまう）。
  useLayoutEffect(() => {
    const target = field.current;
    const previous = measured.current;
    const current = heightInputAt(target === null ? null : target.value, previous, {
      compact,
      expanded,
      disabled: inputDisabled,
    });
    measured.current = current;
    if (target === null || !needsFit(previous, current)) return;
    fit(target, expanded);
  });

  // 高さが変わるのは開閉を押したときだけにする。打鍵に合わせた伸縮まで滑らせると、
  // 1 文字ごとに箱が動いて入力の手応えが鈍る。
  useLayoutEffect(() => {
    const target = field.current;
    const from = toggleFrom.current;
    toggleFrom.current = null;
    if (target === null || from === null) return;
    const to = target.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    heightAnimation.current = target.animate(
      [
        // min-height / max-height も一緒に動かす。状態ごとの制約が残ると、始点の高さが
        // その範囲へ切り詰められて 1 フレーム目で跳ぶ（開: 42→64px、閉: 293→220px）。
        { height: `${from}px`, minHeight: `${from}px`, maxHeight: `${from}px` },
        { height: `${to}px`, minHeight: `${to}px`, maxHeight: `${to}px` },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [expanded]);

  // 引用を足したあと、再描画された入力欄の末尾（引用の後の空行）へカーソルを移す。
  // 対象の本文は useComposer が持ち、この hook からは deps に取れない。キャレットの
  // 要求が残っている描画の後だけ動くよう、毎描画の先頭で控えを見る。
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const target = field.current;
    if (target === null) return;
    target.focus();
    target.setSelectionRange(caret, caret);
    fit(target, expanded);
  });

  const toggle = () => {
    toggleFrom.current = field.current?.getBoundingClientRect().height ?? null;
    setExpandedOpen((current) => !current);
  };

  return { field, pendingCaret, expanded, fit, toggle };
}
