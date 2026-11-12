import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage, ChatSnapshot } from "../server/chat/contract";

// 確定した返答をそのまま描くと、長い返答では先頭がスクロールの外へ流れる。追記された
// agent メッセージだけを時間で区切って出し、読み始める位置を保つ。生成の進捗ではなく
// 演出なので、本文が届く前には始められない。会話の正は従来どおりセッションのまま。
export const REVEAL_TICK_MS = 150;
export const REVEAL_MIN_MS = 2_000;
export const REVEAL_MAX_MS = 5_000;
// 2〜3 行の返答は一瞬で読める。演出を挟むと待たされるだけ。
export const REVEAL_MIN_CHARS = 200;
// これを超える本文は Markdown の再描画が重い。今までどおり一度に出す。
export const REVEAL_MAX_CHARS = 32_000;
// 1 文字あたりの時間。短い返答ほど速く終わるが、下限と上限で挟む。
const REVEAL_MS_PER_CHAR = 6;

type RevealPlan = { id: string; chars: string[]; durationMs: number };

// 追記された最後の agent メッセージだけを対象にする。前回の末尾が新しい側に残って
// いないとき（ペイン切替・/new・圧縮で窓が動いた）は追記とみなさない。
export function revealTarget(previous: ChatSnapshot, next: ChatSnapshot): ChatMessage | null {
  const last = previous.messages.at(-1);
  if (last !== undefined && !next.messages.some((message) => message.id === last.id)) return null;
  const known = new Set(previous.messages.map((message) => message.id));
  const added = next.messages.filter((message) => !known.has(message.id));
  const target = added.at(-1);
  return target !== undefined && target.role === "agent" ? target : null;
}

export function revealDurationMs(length: number): number {
  return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, length * REVEAL_MS_PER_CHAR));
}

export function revealPlan(message: ChatMessage, reducedMotion: boolean): RevealPlan | null {
  if (reducedMotion) return null;
  const chars = Array.from(message.text);
  if (chars.length < REVEAL_MIN_CHARS || chars.length > REVEAL_MAX_CHARS) return null;
  return { id: message.id, chars, durationMs: revealDurationMs(chars.length) };
}

// 経過時間から見せる文字数を出す。隠れたタブでタイマーが間引かれても、戻ったときに
// 経過ぶんまで進む（差分を数え上げない）。
export function revealedLength(total: number, elapsedMs: number, durationMs: number): number {
  if (total <= 0) return 0;
  if (durationMs <= 0) return total;
  return Math.max(1, Math.min(total, Math.ceil((total * elapsedMs) / durationMs)));
}

export type MessageReveal = { id: string; text: string };

type ActiveReveal = RevealPlan & { startedAt: number; shown: number };

export function useMessageReveal(snapshot: ChatSnapshot | null): MessageReveal | null {
  // 初回の履歴を再生しないため、比べる相手はこのフックが受け取った最初のスナップショット。
  const previous = useRef<ChatSnapshot | null>(null);
  const [reveal, setReveal] = useState<ActiveReveal | null>(null);

  // 追記を見つけたら、全文を一度描いてから縮めない。描画のコミットのうちに
  // 途中の本文へ差し替える（useLayoutEffect）。全文が 1 フレームだけ見えて、
  // その高さへスクロールが飛ぶのを避ける。
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = snapshot;
    if (snapshot === null) {
      setReveal(null);
      return;
    }
    // 会話を持たない画面から戻ったときは、履歴の途中から始めない。
    if (before === null) return;
    const target = revealTarget(before, snapshot);
    // 動きを減らす設定では演出しない。全文を出すだけ。
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReveal((current) => {
      // 対象がまだ末尾なら、次の取得が届いても最後まで出す。
      if (current !== null && snapshot.messages.at(-1)?.id === current.id) return current;
      if (target === null) return null;
      const plan = revealPlan(target, reduced);
      if (plan === null) return null;
      return {
        ...plan,
        startedAt: Date.now(),
        shown: revealedLength(plan.chars.length, REVEAL_TICK_MS, plan.durationMs),
      };
    });
  }, [snapshot]);

  // 進み具合は state に持ち、刻むのは revealedLength に任せる。
  useEffect(() => {
    if (reveal === null) return;
    const timer = window.setInterval(() => {
      setReveal((current) => {
        if (current === null) return null;
        // 連続で次の返答が届いても、表示を巻き戻さない。新しい演出の初回チャンクが
        // 前の値より小さいうちは、そのまま進める。
        const shown = Math.max(
          current.shown,
          revealedLength(current.chars.length, Date.now() - current.startedAt, current.durationMs),
        );
        if (shown >= current.chars.length) return null;
        return shown === current.shown ? current : { ...current, shown };
      });
    }, REVEAL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [reveal !== null]);

  if (reveal === null) return null;
  return { id: reveal.id, text: reveal.chars.slice(0, reveal.shown).join("") };
}
