import type { ComponentChildren } from "preact";
import { FILE_TREE_LIMIT, type FileTreeEntry, type FileTreeListing } from "../../shared/file-tree";
import { previewUrl } from "../api";
import type { FileTreeView } from "../file-tree-store";
import { ChevronRightIcon } from "../icons";
import { Spinner } from "../Spinner";

type FileTreeProps = {
  paneId: string;
  view: FileTreeView;
  // 広いセルでは会話の左、狭いセルでは会話の上に重ねる。見た目だけの違い。
  side: boolean;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onRetry: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenImage: (url: string, name: string) => void;
};

// 深さごとの字下げ。行の右側は揃えたいので、左だけを inline で決める。
// 12px は --space-3。深い階層でも名前に幅が残るよう、字下げは 1 段だけにする。
function indent(depth: number) {
  return { paddingLeft: `calc(var(--space-4) + ${depth} * var(--space-3))` };
}

function renderChildren(props: FileTreeProps, path: string, depth: number): ComponentChildren[] {
  const listing: FileTreeListing | undefined = props.view.dirs.get(path);
  if (listing === undefined) {
    const failed = props.view.failed.has(path);
    return [
      <li class="hwc-tree-status" style={indent(depth)} key={`status:${path}`}>
        {failed ? (
          <>
            <span>読み込めませんでした</span>
            <button type="button" class="hwc-tree-retry" onClick={() => props.onRetry(path)}>
              再試行
            </button>
          </>
        ) : (
          <>
            <Spinner size={14} />
            <span>読み込み中</span>
          </>
        )}
      </li>,
    ];
  }

  if (listing.entries.length === 0) {
    return [
      <li class="hwc-tree-status" style={indent(depth)} key={`empty:${path}`}>
        空のディレクトリ
      </li>,
    ];
  }

  const rows: ComponentChildren[] = listing.entries.map((entry) => (
    <TreeRow key={entry.path} entry={entry} depth={depth} tree={props} />
  ));
  if (listing.truncated) {
    rows.push(
      <li class="hwc-tree-status" style={indent(depth)} key={`limit:${path}`}>
        先頭 {FILE_TREE_LIMIT} 件を表示しています（全 {listing.total} 件）
      </li>,
    );
  }
  return rows;
}

function TreeRow(props: { entry: FileTreeEntry; depth: number; tree: FileTreeProps }) {
  const { entry, depth, tree } = props;
  const style = indent(depth);

  if (entry.kind === "dir") {
    const expanded = tree.view.expanded.has(entry.path);
    // 一度読んだディレクトリは、折りたたみ中も子を DOM に残す。再展開で取り直さず、
    // 高さのアニメーションだけを走らせる。
    const loaded = tree.view.dirs.has(entry.path);
    const failed = tree.view.failed.has(entry.path);
    const content = (
      <>
        <span class="hwc-tree-mark">
          {entry.expandable ? (
            <span class="hwc-tree-chevron" data-open={expanded}>
              <ChevronRightIcon size={16} />
            </span>
          ) : null}
        </span>
        <span class="hwc-tree-name">{entry.name}</span>
      </>
    );
    if (!entry.expandable) {
      return (
        <li class="hwc-tree-item">
          <div class="hwc-tree-row" style={style} data-blocked="true" title={entry.path}>
            {content}
          </div>
        </li>
      );
    }
    return (
      <li class="hwc-tree-item">
        <button
          type="button"
          class="hwc-tree-row"
          style={style}
          aria-expanded={expanded}
          title={entry.path}
          onClick={() => tree.onToggle(entry.path)}
        >
          {content}
        </button>
        {expanded || loaded || failed ? (
          <div
            class="hwc-tree-slot"
            // 読み込みが終わるまでは 0fr のまま。届いたら開いて高さを動かす。
            data-open={expanded && (loaded || failed) ? "true" : undefined}
            inert={!expanded}
          >
            <ul class="hwc-tree-group">{renderChildren(tree, entry.path, depth + 1)}</ul>
          </div>
        ) : null}
      </li>
    );
  }

  const content = (
    <>
      <span class="hwc-tree-mark" aria-hidden="true" />
      <span class="hwc-tree-name">{entry.name}</span>
    </>
  );

  // テキストと HTML は、この場でチャット領域に開く。画像だけは既存の拡大ダイアログに任せる。
  if (entry.open === "text" || entry.open === "html") {
    const selected = tree.selectedPath === entry.path;
    return (
      <li class="hwc-tree-item">
        <button
          type="button"
          class="hwc-tree-row"
          style={style}
          title={entry.path}
          data-selected={selected ? "true" : undefined}
          aria-current={selected ? "true" : undefined}
          onClick={() => tree.onSelectFile(entry.path)}
        >
          {content}
        </button>
      </li>
    );
  }

  if (entry.open === null) {
    return (
      <li class="hwc-tree-item">
        <div class="hwc-tree-row" style={style} data-blocked="true" title={entry.path}>
          {content}
        </div>
      </li>
    );
  }

  return (
    <li class="hwc-tree-item">
      <button
        type="button"
        class="hwc-tree-row"
        style={style}
        title={entry.path}
        onClick={() =>
          tree.onOpenImage(previewUrl(tree.paneId, { root: 0, name: entry.path }), entry.name)
        }
      >
        {content}
      </button>
    </li>
  );
}

// 根の行は出さない。ペイン見出しにリポジトリ名があり、直下から並べた方が浅く読める。
export function FileTree(props: FileTreeProps) {
  return (
    <div class="hwc-tree-view" data-side={props.side ? "true" : undefined}>
      <ul class="hwc-tree" aria-label="ファイルツリー">
        {renderChildren(props, "", 0)}
      </ul>
    </div>
  );
}
