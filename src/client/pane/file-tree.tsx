import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { FILE_TREE_LIMIT, type FileTreeEntry, type FileTreeListing } from "../../shared/file-tree";
import { previewUrl } from "../requests/panes";
import { useCopy } from "../copy";
import { fileKind } from "../file-kind";
import type { FileTreeIcons } from "../file-tree-display";
import type { FileTreeView } from "../file-tree-store";
import { treeArrowIntent } from "../file-tree-key";
import {
  ChevronRightIcon,
  CopyGlyph,
  FileKindIcon,
  FolderIcon,
  FolderOpenIcon,
  MoreIcon,
  PlusIcon,
} from "../icons";
import { Menu } from "../Menu";
import { shortenPath } from "../select";
import { Spinner } from "../Spinner";

// ツリーの行メニュー。一覧のメニューとは別の要素なので、id も分ける。
const TREE_MENU_ID = "hwc-tree-menu";

type FileTreeProps = {
  paneId: string;
  view: FileTreeView;
  // 行の左に種類の印を出すか。出さないときは、フォルダはシェブロン 1 つ。
  icons: FileTreeIcons;
  // 広いセルでは会話の左右どちらか（設定で選ぶ）、狭いセルでは会話の上に重ねる。
  // 見た目だけの違い。
  side: boolean;
  // 開閉のアニメーション。初回描画で開いているとき（ペインを切り替えて戻ったとき）は
  // shown が true のまま始まり、動かない。
  shown: boolean;
  closing: boolean;
  // キーで開いたか。token は開くたびに増えるので、同じ token を 2 度処理しない。
  // focus はその開閉がキー由来かを示す（ポインタで開いたときは移さない）。
  focusRequest: TreeFocusRequest;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onRetry: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenImage: (url: string, name: string) => void;
  // 行を composer へ運ぶ。パス文字列はペインの作業ディレクトリを知る側で組み立てる。
  onDragStart: (event: DragEvent, entry: FileTreeEntry) => void;
  // フォルダを作業ディレクトリにした新しいスペースを作る。
  onCreateSpace: (path: string) => void;
  // 開けるメニューは常に 1 つ。分割セルのもう一方が開いていれば、そちらは閉じる。
  onOpenMenu: (entry: FileTreeEntry, trigger: HTMLElement) => void;
  onCloseMenu: (path: string) => void;
  // path を渡さないときは、行のボタンごと消えたとしてとにかく捨てる。
  onClearMenu: (path?: string) => void;
};

// ツリーの行へ渡すもの。メニューの開閉は store が持ち、行は開く合図だけを送る。
type TreeContext = FileTreeProps & {
  openMenu: (entry: FileTreeEntry, trigger: HTMLElement) => void;
  // 開いているメニューの行。行の「…」の aria-expanded に使う。
  openMenuPath: string | null;
};

export type TreeFocusRequest = { token: number; focus: boolean };

// 深さごとの字下げ。行の右側は揃えたいので、左だけを inline で決める。
// 12px は --space-3。深い階層でも名前に幅が残るよう、字下げは 1 段だけにする。
export function indent(depth: number) {
  return { paddingLeft: `calc(var(--space-4) + ${depth} * var(--space-3))` };
}

// 行の左の印。アイコンを出すときは開閉をフォルダの形で示し、出さないときは
// 開閉のシェブロン 1 つにする（印を出さないだけで、開閉の合図は残す）。
// 開いた行の印は、名前と同じ濃さにして、いま開いている枝を行の色でも示す。
function TreeMark(props: { entry: FileTreeEntry; expanded: boolean; icons: FileTreeIcons }) {
  const { entry, expanded, icons } = props;
  if (entry.kind === "dir") {
    if (icons === "none") {
      return (
        <span class="hwc-tree-mark" data-open={expanded ? "true" : undefined} aria-hidden="true">
          {entry.expandable ? (
            <span class="hwc-tree-chevron" data-open={expanded}>
              <ChevronRightIcon size={16} />
            </span>
          ) : null}
        </span>
      );
    }
    return (
      <span class="hwc-tree-mark" data-open={expanded ? "true" : undefined} aria-hidden="true">
        {expanded ? <FolderOpenIcon size={16} /> : <FolderIcon size={16} />}
      </span>
    );
  }
  const kind = fileKind(entry.name);
  return (
    <span class="hwc-tree-mark" data-kind={icons === "none" ? undefined : kind} aria-hidden="true">
      {icons === "none" ? null : <FileKindIcon kind={kind} />}
    </span>
  );
}

// 開ける行も開けない行も、同じように composer へ運べる。淡色は hwc が配信できない
// だけで、エージェントはパスから読める。
function dragProps(tree: FileTreeProps, entry: FileTreeEntry) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => tree.onDragStart(event, entry),
  };
}

function renderChildren(props: TreeContext, path: string, depth: number): ComponentChildren[] {
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

// 行の右端のメニュー。行はボタン（または開けない行の div）なので、入れ子にせず
// 兄弟に置く。矢印キーの移動は行だけを辿る。
function TreeMenuButton(props: { entry: FileTreeEntry; tree: TreeContext }) {
  const { entry, tree } = props;
  return (
    <button
      type="button"
      class="hwc-tree-action"
      aria-label={`${entry.path} のメニュー`}
      aria-haspopup="menu"
      aria-expanded={tree.openMenuPath === entry.path}
      aria-controls={TREE_MENU_ID}
      onClick={(event) => tree.openMenu(entry, event.currentTarget)}
    >
      <MoreIcon />
    </button>
  );
}

// 行と右端のメニューをひとつの面に見せる。塗るのは line だけにして、行の箱は
// メニューのぶんだけ狭める（面の塗りは css 側）。
function TreeLine(props: {
  entry: FileTreeEntry;
  blocked: boolean;
  // 押しても開けない行と、git が無視する行。どちらも名前と印を淡色にする。
  muted: boolean;
  selected: boolean;
  row: ComponentChildren;
  tree: TreeContext;
}) {
  const { entry, blocked, muted, selected, row, tree } = props;
  return (
    <div
      class="hwc-tree-line"
      data-blocked={blocked ? "true" : undefined}
      data-muted={muted ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
    >
      {row}
      <TreeMenuButton entry={entry} tree={tree} />
    </div>
  );
}

function TreeRow(props: { entry: FileTreeEntry; depth: number; tree: TreeContext }) {
  const { entry, depth, tree } = props;
  const style = indent(depth);
  const selected = tree.selectedPath === entry.path;

  if (entry.kind === "dir") {
    const expanded = tree.view.expanded.has(entry.path);
    // 一度読んだディレクトリは、折りたたみ中も子を DOM に残す。再展開で取り直さず、
    // 高さのアニメーションだけを走らせる。
    const loaded = tree.view.dirs.has(entry.path);
    const failed = tree.view.failed.has(entry.path);
    const content = (
      <>
        <TreeMark entry={entry} expanded={expanded} icons={tree.icons} />
        <span class="hwc-tree-name">{entry.name}</span>
      </>
    );
    // 子を持てないフォルダ（根の外を指す symlink）は開閉しない。パスのコピーは残す。
    const row = entry.expandable ? (
      <button
        type="button"
        class="hwc-tree-row"
        style={style}
        aria-expanded={expanded}
        title={entry.path}
        onClick={() => tree.onToggle(entry.path)}
        {...dragProps(tree, entry)}
      >
        {content}
      </button>
    ) : (
      <div class="hwc-tree-row" style={style} title={entry.path} {...dragProps(tree, entry)}>
        {content}
      </div>
    );
    return (
      <li class="hwc-tree-item">
        <TreeLine
          entry={entry}
          blocked={!entry.expandable}
          muted={!entry.expandable || entry.ignored === true}
          selected={false}
          row={row}
          tree={tree}
        />
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
      <TreeMark entry={entry} expanded={false} icons={tree.icons} />
      <span class="hwc-tree-name">{entry.name}</span>
    </>
  );

  // テキストと HTML は、この場でチャット領域に開く。画像だけは既存の拡大ダイアログに任せる。
  // 開けないファイルは名前だけ出し、押しても何もしない。
  let row: ComponentChildren;
  if (entry.open === "text" || entry.open === "html") {
    row = (
      <button
        type="button"
        class="hwc-tree-row"
        style={style}
        title={entry.path}
        aria-current={selected ? "true" : undefined}
        onClick={() => tree.onSelectFile(entry.path)}
        {...dragProps(tree, entry)}
      >
        {content}
      </button>
    );
  } else if (entry.open === null) {
    row = (
      <div class="hwc-tree-row" style={style} title={entry.path} {...dragProps(tree, entry)}>
        {content}
      </div>
    );
  } else {
    row = (
      <button
        type="button"
        class="hwc-tree-row"
        style={style}
        title={entry.path}
        onClick={() =>
          tree.onOpenImage(previewUrl(tree.paneId, { root: 0, name: entry.path }), entry.name)
        }
        {...dragProps(tree, entry)}
      >
        {content}
      </button>
    );
  }

  return (
    <li class="hwc-tree-item">
      <TreeLine
        entry={entry}
        blocked={entry.open === null}
        muted={entry.open === null || entry.ignored === true}
        selected={selected}
        row={row}
        tree={tree}
      />
    </li>
  );
}

// 表示中の行をドキュメント順に返す。折りたたんだフォルダの子は DOM に残って
// inert になるので、その中の行は含めない。
function visibleRows(list: HTMLUListElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>("button.hwc-tree-row")).filter(
    (row) => row.closest("[inert]") === null,
  );
}

// 焦点を当てる行。選んでいるファイルがあればそこ、無ければ先頭。
function focusTarget(list: HTMLUListElement): HTMLElement | null {
  const rows = visibleRows(list);
  return rows.find((row) => row.getAttribute("aria-current") === "true") ?? rows[0] ?? null;
}

// ツリーの中の矢印キー。行はボタンなので、既定のままなら矢印はスクロールに使われる。
// 扱ったキーだけ止め、行を移れない端では何もしない。
function onTreeKey(event: KeyboardEvent, list: HTMLUListElement, onToggle: (path: string) => void) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.classList.contains("hwc-tree-row")) return;
  const path = active.getAttribute("title");
  if (path === null) return;
  const dir = active.hasAttribute("aria-expanded");
  const intent = treeArrowIntent(event, {
    dir,
    expanded: dir && active.getAttribute("aria-expanded") === "true",
  });
  if (intent === null) return;
  const rows = visibleRows(list);
  const index = rows.indexOf(active);
  if (index < 0) return;
  const move = (row: HTMLElement | undefined | null) => {
    event.preventDefault();
    row?.focus();
  };

  switch (intent) {
    case "next":
      return move(rows[index + 1]);
    case "previous":
      return move(rows[index - 1]);
    case "expand":
    case "collapse":
      event.preventDefault();
      return onToggle(path);
    case "in": {
      // 子がまだ読み込み中なら、次の行は兄弟。接頭辞で確かめてから移る。
      const child = rows[index + 1];
      return move(
        child?.getAttribute("title")?.startsWith(`${path}/`) === true ? child : undefined,
      );
    }
    case "out": {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
      return move(
        parent === null ? null : rows.find((row) => row.getAttribute("title") === parent),
      );
    }
  }
}

// 行 1 つの操作。どの行もパスをコピーでき、作業ディレクトリにできるフォルダだけ
// 新しいスペースを作れる。コピーする文字列はメニューの中に出す。行が持つのは根からの
// 相対パスだけなので、行の名前だけでは何がクリップボードに入るか分からない。
function RowMenuCard(props: {
  name: string;
  copyTarget: string;
  newSpace: boolean;
  onNewSpace: () => void;
}) {
  const { copiedId, copy } = useCopy();
  const copied = copiedId === "tree-path";
  return (
    <>
      <div class="hwc-menu-head hwc-menu-space-head">
        <span class="hwc-menu-space-text">
          <span class="hwc-menu-space-name">{props.name}</span>
          <span class="hwc-menu-space-path" title={props.copyTarget}>
            {shortenPath(props.copyTarget)}
          </span>
        </span>
        <button
          type="button"
          role="menuitem"
          class="hwc-menu-copy"
          aria-label={copied ? "コピーしました" : "パスをコピー"}
          onClick={() => copy("tree-path", props.copyTarget)}
        >
          <CopyGlyph copied={copied} />
        </button>
      </div>
      {props.newSpace ? (
        <button type="button" role="menuitem" class="hwc-menu-item" onClick={props.onNewSpace}>
          <PlusIcon size={14} />
          新しいスペース
        </button>
      ) : null}
    </>
  );
}

// 根の行は出さない。ペイン見出しにリポジトリ名があり、直下から並べた方が浅く読める。
export function FileTree(props: FileTreeProps) {
  const list = useRef<HTMLUListElement>(null);
  const handled = useRef(0);
  // 確定前の焦点。並べ方が変わるとツリーごと作り直され、Menu も開き直されて
  // 先頭の項目へ焦点を移す。そのあとでメニューを捨てると焦点の行き場が無くなるので、
  // 捨てる前にここへ戻す（描画中の読み取りは、子のレイアウト効果より前でしかできない）。
  const focusedBefore = useRef<HTMLElement | null>(null);
  focusedBefore.current =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // 開いているメニューは store が 1 つだけ持つ。根が変わると store が一覧ごと捨てるので、
  // 消えた行の相対パスを新しい根と結合しない。行のボタンが DOM から外れている間は
  // 位置合わせができないので描かない（ツリーを閉じた・セルが外れた後）。
  const menu = props.view.menu?.trigger.isConnected === true ? props.view.menu : null;

  // 根の一覧は開いた後に届く。行が無い間は待ち、届いたら 1 度だけ焦点を合わせる。
  // 展開のたびに dirs が変わっても、同じ開閉で焦点を取り直さない。
  useEffect(() => {
    const request = props.focusRequest;
    if (!request.focus || request.token === handled.current) return;
    if (props.view.dirs.get("") === undefined) return;
    const root = list.current;
    if (root === null) return;
    handled.current = request.token;
    focusTarget(root)?.focus();
  }, [props.focusRequest, props.view.dirs]);

  // 行のボタンが作り直されると、控えた要素は切り離される。並べ方の切り替え（重ね表示から
  // 並べ表示へ移る）では、この描画ではまだ DOM に残っているので、確定を待って確かめる。
  // 描画前に捨てるので、上端に置かれた面が見えることはない。
  useLayoutEffect(() => {
    const opening = props.view.menu;
    if (opening === null || opening.trigger.isConnected) return;
    const card = document.getElementById(TREE_MENU_ID);
    if (card !== null && card.contains(document.activeElement)) {
      focusedBefore.current?.focus({ preventScroll: true });
    }
    props.onClearMenu();
  });

  const onKeyDown = (event: KeyboardEvent) => {
    const root = list.current;
    if (root !== null) onTreeKey(event, root, props.onToggle);
  };

  const tree: TreeContext = {
    ...props,
    openMenu: (entry, trigger) => props.onOpenMenu(entry, trigger),
    openMenuPath: menu?.open === true ? menu.path : null,
  };

  // メニューはスクロールする面の外に置く。行と同じ面に入れると、ツリーを閉じる間の inert で
  // メニューごと押せなくなる。
  return (
    <>
      <div
        class="hwc-tree-view"
        data-side={props.side ? "true" : undefined}
        data-shown={props.shown ? "true" : "false"}
        data-closing={props.closing ? "true" : undefined}
        inert={props.closing}
        aria-hidden={props.closing ? "true" : undefined}
      >
        <ul
          class="hwc-tree"
          aria-label="ファイルツリー"
          data-icons={props.icons}
          ref={list}
          onKeyDown={onKeyDown}
        >
          {renderChildren(tree, "", 0)}
        </ul>
      </div>
      {menu === null ? null : (
        <Menu
          id={TREE_MENU_ID}
          label={`${menu.name} の操作`}
          trigger={menu.trigger}
          open={menu.open}
          onClose={() => props.onCloseMenu(menu.path)}
          onExited={() => props.onClearMenu(menu.path)}
          closeOnScroll
        >
          <RowMenuCard
            name={menu.name}
            copyTarget={menu.copyTarget}
            newSpace={menu.newSpace}
            onNewSpace={() => {
              props.onCloseMenu(menu.path);
              props.onCreateSpace(menu.path);
            }}
          />
        </Menu>
      )}
    </>
  );
}
