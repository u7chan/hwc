import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Ref, RefObject, TargetedEvent } from "preact";
import type { PaneOutputHandle } from "../commands";
import { isLayoutShift, isNearBottom, isUserScrollDuringGrowth } from "../scroll";
import type { CompactionEcho, CompactionRun } from "./use-compaction-echo";

export type UseOutputFollow = {
  atBottom: boolean;
  // 追従するかは state が正。イベント購読からも読むので、同じ値を ref に写す。
  setPinned: (next: boolean) => void;
  jumpToLatest: () => void;
  onScroll: (event: TargetedEvent<HTMLDivElement, Event>) => void;
};

// 出力の自動追従。最新が見えている間だけ底へ寄せ、読み返しているときは動かさない。
// 高さが変わっただけのスクロール（入力欄や添付が伸縮して底が詰まる）は利用者の操作ではない。
export function useOutputFollow(options: {
  scroller: RefObject<HTMLDivElement | null>;
  // 選択ツールバーを出している間は止める。購読を張り直さずに読むので ref で受ける。
  quoting: RefObject<boolean>;
  outputRef: Ref<PaneOutputHandle>;
  // クリア後の読み直しを useOutputVersion へ伝える。version は購読 side が先に要るため、
  // 状態はそちらが持ち、ここは要求だけを出す。
  requestOutputRefresh: () => void;
  // 追従の契機になる内容。メッセージ一覧か端末出力そのもの。
  content: readonly unknown[] | string | null;
  replying: boolean;
  pendingCount: number;
  revealLength: number | undefined;
  notice: string | null;
  compactionRun: CompactionRun | null;
  compactionEcho: CompactionEcho | null;
  confirmation: { id: string } | null;
}): UseOutputFollow {
  const {
    scroller,
    quoting,
    outputRef,
    requestOutputRefresh,
    content,
    replying,
    pendingCount,
    revealLength,
    notice,
    compactionRun,
    compactionEcho,
    confirmation,
  } = options;
  const [atBottom, setAtBottom] = useState(true);
  // 追従するかは state が正。イベント購読からも読むので、同じ値を ref に写す
  // （chat.ts の statusRef と同じ扱い）。更新は setPinned の 1 経路だけ。
  const pinned = useRef(true);
  // 直前の content 高・表示領域の高さ。高さの変化と利用者の操作を分けるために使う。
  const lastHeight = useRef(0);
  const lastClientHeight = useRef(0);

  const setPinned = (next: boolean) => {
    pinned.current = next;
    setAtBottom(next);
  };

  // 最新が見えている間だけ追従する。読み返しているときは勝手に動かさない。
  // 失敗の notice はメッセージ領域を縮めるので、出たときも追従し直す。
  // 圧縮の吹き出しと進捗行は chat の末尾にローカルで足すため、content が変わらない
  // 間も追従できるよう compactionRun / compactionEcho も依存に入れる。
  useEffect(() => {
    if (confirmation !== null) return;
    const element = scroller.current;
    if (element && atBottom && !quoting.current) element.scrollTop = element.scrollHeight;
  }, [
    content,
    replying,
    atBottom,
    pendingCount,
    // 逐次表示は本文が伸びるたびに底へ寄せる。伸びなければ何もしない。
    revealLength,
    notice,
    compactionRun,
    compactionEcho,
    confirmation?.id,
  ]);

  // 画像の読み込みや入力欄の伸びで高さが後から変わっても、最新を見ている間は底に留める。
  // 画像の load は bubble しないので capture で拾い、領域の伸縮は ResizeObserver で拾う。
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const keep = () => {
      lastHeight.current = element.scrollHeight;
      lastClientHeight.current = element.clientHeight;
      if (confirmation !== null || !pinned.current || quoting.current) return;
      element.scrollTop = element.scrollHeight;
    };
    // 初回は今の高さを基準にする。0 のまま残すと、最初のスクロールを伸縮と誤認する。
    lastHeight.current = element.scrollHeight;
    lastClientHeight.current = element.clientHeight;
    element.addEventListener("load", keep, true);
    const observer = new ResizeObserver(keep);
    observer.observe(element);
    return () => {
      element.removeEventListener("load", keep, true);
      observer.disconnect();
    };
  }, [confirmation?.id]);

  const jumpToLatest = () => {
    setPinned(true);
    const element = scroller.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const onScroll = (event: TargetedEvent<HTMLDivElement, Event>) => {
    if (confirmation !== null) return;
    const element = event.currentTarget;
    const now = {
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
    const last = {
      scrollTop: now.scrollTop,
      clientHeight: lastClientHeight.current,
      scrollHeight: lastHeight.current,
    };
    lastHeight.current = now.scrollHeight;
    lastClientHeight.current = now.clientHeight;
    // 高さが変わっただけなら、底を詰めた副作用。読み返しの意思とはみなさない。
    // 縮んだ結果ブラウザが底へ寄せた場合に備え、追従の判断は今の位置で取り直す。
    // ただし縦に伸びたときは、伸びる前の底から離れた位置なら利用者が動かしたと
    // みなす。逐次表示は 150ms ごとに高さが変わるので、これが無いと上へ
    // スクロールしても高さの変化と誤認してすぐ底へ戻される。
    if (isLayoutShift(now, last)) {
      if (isUserScrollDuringGrowth(now, last)) {
        setPinned(isNearBottom(now));
        return;
      }
      if (pinned.current) element.scrollTop = element.scrollHeight;
      if (isNearBottom(now)) setPinned(true);
      return;
    }
    setPinned(isNearBottom(now));
  };

  useImperativeHandle(outputRef, () => ({
    refreshOutput: () => {
      setPinned(true);
      requestOutputRefresh();
    },
  }));

  return { atBottom, setPinned, jumpToLatest, onScroll };
}
