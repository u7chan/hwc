import { useCopy } from "./copy";
import { CopyGlyph } from "./icons";
import { shortenPath } from "./select";

type WorkspaceMenuHeadProps = {
  label: string;
  path: string | null;
};

// パスはスペースを見分けるための手掛かりでもある。ラベルの下に出し、コピーは
// 末尾のアイコンに集約する。押してもメニューは閉じない。
export function WorkspaceMenuHead(props: WorkspaceMenuHeadProps) {
  const { copiedId, copy } = useCopy();
  const path = props.path;
  const copied = copiedId === "path";

  return (
    <div class="hwc-menu-head hwc-menu-space-head">
      <span class="hwc-menu-space-text">
        <span class="hwc-menu-space-name">{props.label}</span>
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
