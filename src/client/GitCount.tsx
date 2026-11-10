import type { GitSync } from "../shared/git";
import { gitStatusLabel } from "../shared/git";

type GitCountProps = {
  sync: GitSync | null;
};

// 上流との差は、動きがある側だけを出す。0 の側まで出すと、メニューの入口や
// ラベルの意味が数字の 0 に埋もれる。押せる要素ではないので、ボタンにはしない。
export function GitCount(props: GitCountProps) {
  const sync = props.sync;
  if (sync === null || sync.upstream === null) return null;
  if (sync.ahead === 0 && sync.behind === 0) return null;
  const label = gitStatusLabel(sync);
  return (
    <span class="hwc-git-count" role="img" aria-label={label} title={label}>
      {sync.ahead === 0 ? null : (
        <span class="hwc-git-count-part" data-tone="ahead">
          ↑{sync.ahead}
        </span>
      )}
      {sync.behind === 0 ? null : (
        <span class="hwc-git-count-part" data-tone="behind">
          ↓{sync.behind}
        </span>
      )}
    </span>
  );
}
