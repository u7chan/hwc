import type { ComponentChildren } from "preact";
import type { ChatFile } from "../../server/chat/contract";
import { formatFileSize } from "../../shared/attachments";
import {
  FILE_TREE_LIMIT,
  type FileTreeEntry,
  type FileTreeFile,
  type FileTreeListing,
} from "../../shared/file-tree";
import { previewTextUrl, previewUrl } from "../api";
import type { FileTreeView } from "../file-tree-store";
import { ChevronDownIcon, ChevronRightIcon } from "../icons";
import { Spinner } from "../Spinner";

type FileTreeProps = {
  paneId: string;
  view: FileTreeView;
  onToggle: (path: string) => void;
  onRetry: (path: string) => void;
  onOpenPreview: (file: ChatFile) => void;
  onOpenImage: (url: string, name: string) => void;
};

// 深さごとの字下げ。行の右側は揃えたいので、左だけを inline で決める。
// 12px は --space-3。深い階層でも名前に幅が残るよう、字下げは 1 段だけにする。
function indent(depth: number) {
  return { paddingLeft: `calc(var(--space-4) + ${depth} * var(--space-3))` };
}

function openFile(props: FileTreeProps, entry: FileTreeFile): void {
  // 画像もプレビューの配信 URL を使う。no-store なので版は要らず、画像ダイアログは
  // この URL をそのまま img に使う。
  if (entry.open === "image") {
    props.onOpenImage(previewUrl(props.paneId, { root: 0, name: entry.path }), entry.name);
    return;
  }
  if (entry.open !== "html") return;
  props.onOpenPreview({ name: entry.path, version: entry.version, kind: "html", root: 0 });
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
    const content = (
      <>
        <span class="hwc-tree-mark">
          {entry.expandable ? (
            expanded ? (
              <ChevronDownIcon size={16} />
            ) : (
              <ChevronRightIcon size={16} />
            )
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
        {expanded ? (
          <ul class="hwc-tree-group">{renderChildren(tree, entry.path, depth + 1)}</ul>
        ) : null}
      </li>
    );
  }

  const content = (
    <>
      <span class="hwc-tree-mark" aria-hidden="true" />
      <span class="hwc-tree-name">{entry.name}</span>
      <span class="hwc-tree-size">{formatFileSize(entry.size)}</span>
    </>
  );

  // テキストは既存の raw 配信を新しいタブで開く。リンクにしておくと、中クリックや
  // URL のコピーもブラウザに任せられる。
  if (entry.open === "text") {
    return (
      <li class="hwc-tree-item">
        <a
          class="hwc-tree-row"
          style={style}
          href={previewTextUrl(tree.paneId, { root: 0, name: entry.path })}
          target="_blank"
          rel="noopener noreferrer"
          title={entry.path}
        >
          {content}
        </a>
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
        onClick={() => openFile(tree, entry)}
      >
        {content}
      </button>
    </li>
  );
}

// 根の行は出さない。ペイン見出しにリポジトリ名があり、直下から並べた方が浅く読める。
export function FileTree(props: FileTreeProps) {
  return (
    <div class="hwc-tree-view">
      <ul class="hwc-tree" aria-label="ファイルツリー">
        {renderChildren(props, "", 0)}
      </ul>
    </div>
  );
}
