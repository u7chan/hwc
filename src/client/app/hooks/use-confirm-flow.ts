import type { RefObject } from "preact";
import { useRef, useState } from "preact/hooks";
import type { CloseOutcome } from "../../api";
import { canConfirm, cancelConfirm, type ConfirmPhase, type ConfirmState } from "../confirm";

type ConfirmFlowOptions<T, Extra extends string> = {
  // 対象がまだあるか。スナップショットが変われば false になり、確認を押せなくする。
  present: (target: T) => boolean;
  // 実行する要求。done 以外は失敗として扱う。
  request: (target: T) => Promise<CloseOutcome>;
  // 応答の後始末。進める先の phase を返す。null なら確認を閉じる。
  // 応答より先に対象が消えていれば、phase はその分だけ進んだ状態で渡る。
  settled: (
    state: ConfirmState<T, ConfirmPhase | Extra>,
    outcome: CloseOutcome,
  ) => ConfirmPhase | Extra | null;
};

export type ConfirmFlow<T, P extends string = ConfirmPhase> = {
  // 開いていなければ null。
  state: ConfirmState<T, P> | null;
  // 最新の状態。SSE の購読は 1 度しか張らないので、届いたスナップショットの判定はここから読む。
  latest: RefObject<ConfirmState<T, P> | null>;
  // 対象がまだあるか。開いていなければ false。
  available: boolean;
  // 確認を開く。対象が既に無ければ開かず、false を返す（呼んだ側はメニューを閉じない）。
  open: (target: T) => boolean;
  cancel: () => void;
  confirm: () => void;
  // 応答を待たずにフロー固有の phase（削除の leave）へ進める。一覧の行のアニメーションと、
  // スナップショットが先に対象を落とした経路から使う。
  update: (next: (current: ConfirmState<T, P> | null) => ConfirmState<T, P> | null) => void;
};

// 3 つの確認（ペインを閉じる・ワークツリーを削除する・スペースを閉じる）は同じ形をしている。
// 対象と phase と in-flight の目印をここにまとめ、違いは 3 つの引数だけに残す。
export function useConfirmFlow<T, Extra extends string = never>(
  options: ConfirmFlowOptions<T, Extra>,
): ConfirmFlow<T, ConfirmPhase | Extra> {
  type State = ConfirmState<T, ConfirmPhase | Extra>;
  const [state, setState] = useState<State | null>(null);
  // state の更新を待たずに二重送信を防ぐ。描画中に代入して、effect を挟んだ 1 フレーム
  // 古い値を読ませない。
  const latest = useRef<State | null>(null);
  latest.current = state;
  const inFlight = useRef(false);
  const available = state !== null && options.present(state.target);

  const open = (target: T) => {
    if (!options.present(target)) return false;
    setState({ target, phase: "confirm" });
    return true;
  };

  // 送信中は取り消しを受け付けない。結果の反映を 1 回に保つ。
  const cancel = () => setState(cancelConfirm);

  const confirm = () => {
    if (!canConfirm(state, available) || inFlight.current) return;
    inFlight.current = true;
    const target = state.target;
    // 実行中は操作を受け付けない。結果の反映を 1 回に保つ。
    setState((current) => (current === null ? null : { ...current, phase: "busy" }));
    void options.request(target).then((outcome) => {
      inFlight.current = false;
      setState((current) => {
        // 応答より先にスナップショットが対象を落としていれば、確認は既に閉じている。
        // 遅れて届いた応答で確認や表示を戻さない。
        if (current === null) return null;
        const phase = options.settled(current, outcome);
        return phase === null ? null : { ...current, phase };
      });
    });
  };

  const update = (next: (current: State | null) => State | null) => setState(next);

  return { state, latest, available, open, cancel, confirm, update };
}
