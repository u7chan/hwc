import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { StateMessage } from "../../api";
import { clockSkew, serverClockNow } from "../../time";

export type UseServerClock = {
  now: number;
  skew: RefObject<number>;
  receive: (message: StateMessage) => void;
};

// 画面の「今」はサーバーの時計で刻む。状態が動かない間も経過が進むよう 1 秒ごとに描き直す。
export function useServerClock(): UseServerClock {
  // サーバーの時計と端末の時計の差。スナップショットを受けた場所で固定し、以後の描画では
  // ここに入れた値だけを使う。
  const skew = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  const receive = (message: StateMessage) => {
    skew.current = clockSkew(message.now, Date.now(), skew.current);
    // 補正は次の刻みを待たない。待つと、状態が届いてから最初の刻みまで端末時計のずれだけ
    // 経過がずれて見える（非表示タブでは可視化後の最初の刻みまで残る）。
    setNow(serverClockNow(Date.now(), skew.current));
  };

  useEffect(() => {
    const timer = setInterval(() => setNow(serverClockNow(Date.now(), skew.current)), 1000);
    return () => clearInterval(timer);
  }, []);

  return { now, skew, receive };
}
