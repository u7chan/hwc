import type { GitSync } from "../shared/git";
import type { GitSyncFailure } from "./api";
import { FetchIcon, PullIcon } from "./icons";

type WorkspaceGitActionsProps = {
  sync: GitSync | null;
  busy: "fetch" | "pull" | null;
  failed: { action: "fetch" | "pull"; error: GitSyncFailure } | null;
  onRun: (action: "fetch" | "pull") => void;
};

function failureNote(action: "fetch" | "pull", error: GitSyncFailure): string {
  switch (error) {
    case "no_remote":
      return "リモートがありません。";
    case "no_upstream":
      return "上流ブランチがありません。";
    case "not_git_worktree":
      return "git のチェックアウトではありません。";
    case "git_unavailable":
      return "git を実行できません。";
    case "failed":
      return action === "fetch"
        ? "フェッチできませんでした。接続と認証を確認してください。"
        : "プルできませんでした。fast-forward できない、作業ツリーに変更がある、または接続に問題があります。";
  }
}

export function WorkspaceGitActions(props: WorkspaceGitActionsProps) {
  const sync = props.sync;
  if (sync === null || !sync.hasRemote) return null;
  const disabled = props.busy !== null;
  return (
    <>
      <hr class="hwc-menu-separator" />
      <button
        type="button"
        role="menuitem"
        class="hwc-menu-item"
        disabled={disabled}
        onClick={() => props.onRun("fetch")}
      >
        <FetchIcon size={14} />
        {props.busy === "fetch" ? "フェッチしています…" : "フェッチ"}
      </button>
      {sync.upstream === null ? (
        <p class="hwc-menu-note">上流ブランチがありません</p>
      ) : (
        <button
          type="button"
          role="menuitem"
          class="hwc-menu-item"
          disabled={disabled}
          onClick={() => props.onRun("pull")}
        >
          <PullIcon size={14} />
          {props.busy === "pull" ? "プルしています…" : "プル"}
        </button>
      )}
      {props.failed === null ? null : (
        <p class="hwc-menu-note" role="alert">
          {failureNote(props.failed.action, props.failed.error)}
        </p>
      )}
    </>
  );
}
