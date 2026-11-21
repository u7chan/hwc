// 端末出力・会話・実行中の段階は、どれも「見えている間だけ一定間隔で読み直す」。予約・要求の
// 打ち切り・可視状態の購読という配管をここへ集め、何をどれくらいの間隔で読むかだけを hook が
// 決める。同じ配管を 3 か所で持つと、隠れタブの止まり方や失敗の出し方が画面ごとにずれる。

// 打ち切りは失敗ではない。端末出力へも切り替えない。
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "name" in error && (error as { name: unknown }).name === "AbortError";
}

export type Poll = {
  // 予約を捨てて、その場で 1 回読む。
  load: () => void;
  // 予約と取得中の要求を捨てる。購読は続けるので、可視に戻ればまた読む。
  pause: () => void;
  // 購読もやめる。以後 load は効かない。
  stop: () => void;
};

export type PollOptions<T> = {
  // 次の取得までの待ち時間。null なら予約しない（隠れている・読む理由が無い）。
  // 予約のたびに呼ぶので、予約が何を前提にしたかはここで控えられる。
  delay: () => number | null;
  // 1 回の取得。打ち切りは signal で伝える。
  read: (signal: AbortSignal) => Promise<T>;
  // 取得できた結果を今の画面へ反映する。打ち切られた要求の結果はここへ来ない。
  apply: (value: T) => void;
  // 取得が失敗したとき。打ち切りは失敗に含めない。
  failed: () => void;
  // 取得を始めるとき、進行中の要求を打ち切るか。端末出力は打ち切らない。
  // 同じ出力を読み直すだけなので、取得中の結果を捨てる理由が無い。
  replace?: boolean;
  // 開始時と、画面が見えるようになったときの動作。既定はその場で 1 回読む。
  // 開始時は予約も取得中の要求も無いので、reason を見るのは、可視へ戻ったときだけ表示を
  // 捨てたい hook（実行中の段階）に限られる。
  resume?: (poll: Poll, reason: "start" | "visible") => void;
};

export function startPoll<T>(options: PollOptions<T>): Poll {
  const { delay, read, apply, failed, replace = false } = options;
  const wake = options.resume ?? ((poll: Poll) => poll.load());
  let active = true;
  let timer: number | undefined;
  let controller: AbortController | null = null;

  function cancelTimer() {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    cancelTimer();
    const next = delay();
    if (next !== null) timer = window.setTimeout(() => void load(), next);
  }

  async function load() {
    if (!active) return;
    cancelTimer();
    if (replace) controller?.abort();
    const current = new AbortController();
    controller = current;
    try {
      const value = await read(current.signal);
      if (!active || current.signal.aborted) return;
      apply(value);
    } catch (error) {
      // 隠れた・読み直しに置き換えられた・hook が消えた、のどれも失敗ではない。
      if (!active || current.signal.aborted || isAbortError(error)) return;
      failed();
    } finally {
      // 追い越された要求が、後から始まった要求の持ち物を消さないようにする。
      if (controller === current) controller = null;
    }
    // 予約は取得が終わってから張る。読んでいる間にもう 1 本走らせず、間隔は完了から数える。
    // 失敗しても張り直す。次の取得で直る。
    if (active) schedule();
  }

  function pause() {
    cancelTimer();
    controller?.abort();
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") {
      pause();
      return;
    }
    wake(poll, "visible");
  }

  const poll: Poll = {
    load: () => void load(),
    pause,
    stop: () => {
      active = false;
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };

  document.addEventListener("visibilitychange", onVisibility);
  wake(poll, "start");
  return poll;
}
