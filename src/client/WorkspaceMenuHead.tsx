import { useCopy } from "./copy";
import { CopyGlyph } from "./icons";
import { shortenPath } from "./select";

type WorkspaceMenuHeadProps = {
  label: string;
  branch: string | null;
  path: string | null;
};

// パスはスペースを見分けるための手掛かりでもある。ラベルの下に出し、コピーは
// 末尾のアイコンに集約する。押してもメニューは閉じない。
// ブランチは一覧の帯とツリーでは省略か非表示になる幅しかなく、全文を読める面がここだけ
// になる。帯の `worktree/` を落とす省略は幅の都合なので、ここでは全文を出す。
export function WorkspaceMenuHead(props: WorkspaceMenuHeadProps) {
  const { copiedId, copy } = useCopy();
  const path = props.path;
  const copied = copiedId === "path";

  return (
    <div class="hwc-menu-head hwc-menu-space-head">
      <span class="hwc-menu-space-text">
        <span class="hwc-menu-space-name">{props.label}</span>
        {props.branch === null ? null : <span class="hwc-menu-space-branch">{props.branch}</span>}
        {path === null ? null : (
          <span class="hwc-menu-space-path" title={path}>
            {shortenPath(path)}
          </span>
        )}
      </span>
      {path === null ? null : (
        <button
          type="button"
          role="menuitem"
          class="hwc-menu-copy"
          aria-label={copied ? "コピーしました" : "スペースのパスをコピー"}
          onClick={() => copy("path", path)}
        >
          <CopyGlyph copied={copied} />
        </button>
      )}
    </div>
  );
}
