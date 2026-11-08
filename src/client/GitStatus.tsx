import type { GitSync } from "../shared/git";
import { gitStatusLabel } from "../shared/git";
import { MENU_ID } from "./Menu";

type GitStatusProps = {
  sync: GitSync | null;
  expanded: boolean;
  onOpen: (trigger: HTMLElement) => void;
};

// 上流ブランチがある間は 0 も出す。同期していることと、ここがメニューの入口であることを
// 同時に示す。上流が無い・読めないときは数字の意味が無いので出さない。
export function GitStatus(props: GitStatusProps) {
  const sync = props.sync;
  if (sync === null || sync.upstream === null) return null;
  const label = gitStatusLabel(sync);
  return (
    <button
      type="button"
      class="hwc-git-status"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={props.expanded}
      aria-controls={MENU_ID}
      title={label}
      onClick={(event) => props.onOpen(event.currentTarget)}
    >
      <span class="hwc-git-status-part" data-tone={sync.ahead > 0 ? "ahead" : "zero"}>
        ↑{sync.ahead}
      </span>
      <span class="hwc-git-status-part" data-tone={sync.behind > 0 ? "behind" : "zero"}>
        ↓{sync.behind}
      </span>
    </button>
  );
}
