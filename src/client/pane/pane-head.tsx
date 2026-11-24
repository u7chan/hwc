import type { ComponentChildren, RefObject } from "preact";
import type { PaneState } from "../../server/herdr/state";
import { gitStatusLabel, type GitSync } from "../../shared/git";
import type { PullRequest } from "../../shared/pull-request";
import { GitCount } from "../GitCount";
import { ChevronDownIcon, CopyGlyph, FolderIcon, MoreIcon } from "../icons";
import { MENU_ID } from "../Menu";
import { ParentMark } from "../ParentMark";
import { placeChip, pullRequestLabel, type PaneContext } from "../select";

// 見出しの「ファイル」ボタン。開閉は呼び出し側の hook が持ち、ここは見た目だけを出す。
type FilesButton = {
  // ツリーが開いていて、閉じるアニメーションの途中でもない。
  open: boolean;
  // ツリーを閉じたあとに焦点を戻す先。閉じる操作はここから入る。
  buttonRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
};

// ペイン ID とコピーの知らせ。知らせは本文の行と共有するので、状態は呼び出し側が持つ。
type CopyBadge = {
  copied: boolean;
  onCopy: () => void;
};

// 見出しのボタンが開くメニュー。対象の id は見出しが持つ pane / context から決める。
type HeadMenu = {
  open: boolean;
  onOpen: (trigger: HTMLElement) => void;
};

type PaneHeadProps = {
  pane: PaneState;
  context: PaneContext;
  // 親ペインの印。セル見出しに出す。
  parentPaneIds: ReadonlySet<string>;
  // ブランチの文字。PR のチップもこの値で引く。
  branch: string | null;
  sync: GitSync | null;
  pullRequest: PullRequest | null;
  files: FilesButton;
  copy: CopyBadge;
  spaceMenu: HeadMenu;
  paneMenu: HeadMenu;
  // ツリーの見出しを並べる左右の枠。どちらに置くかは、セルの幅を知る呼び出し側が決める。
  leading: ComponentChildren;
  trailing: ComponentChildren;
};

// セルの見出し。名前と種類アイコンはタブ列と重複するので出さない。ブランチ・PR・
// ファイル・ID・メニューと、作成元スペースだけを残す。
export function PaneHead(props: PaneHeadProps) {
  const { pane, context, branch, sync, pullRequest } = props;
  const repoUrl = sync?.repoUrl ?? null;
  // 作成元スペースだけを出す。現在のスペースはタブ列が言うので、ここでは繰り返さない。
  const place = placeChip(context.parentSpaceName, context.workspaceName);
  const placeTitle =
    place === null
      ? ""
      : `${context.parentSpaceLabel ?? context.parentSpaceName ?? ""} / ${context.workspaceLabel} / ${context.tabLabel}`;

  return (
    <div class="hwc-pane-head">
      {props.leading}
      <div class="hwc-pane-head-main">
        <div class="hwc-pane-head-content">
          {branch === null ? (
            context.repoName === null ? null : repoUrl === null ? (
              <span class="hwc-pane-head-repo" title={context.repoName}>
                {context.repoName}
              </span>
            ) : (
              <a
                class="hwc-pane-head-repo"
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`${context.repoName} を GitHub で開く`}
                title={context.repoName}
              >
                {context.repoName}
              </a>
            )
          ) : (
            <button
              type="button"
              class="hwc-pane-head-branch-menu"
              aria-label={`${branch} のスペースメニュー${sync === null ? "" : `、${gitStatusLabel(sync)}`}`}
              aria-haspopup="menu"
              aria-expanded={props.spaceMenu.open}
              aria-controls={MENU_ID}
              data-open={props.spaceMenu.open}
              onClick={(event) => props.spaceMenu.onOpen(event.currentTarget)}
            >
              <span class="hwc-pane-head-branch" title={branch}>
                {branch}
              </span>
              <GitCount sync={sync} />
              <span class="hwc-chevron-down">
                <ChevronDownIcon size={12} />
              </span>
            </button>
          )}
          {branch === null ? <GitCount sync={sync} /> : null}
          {props.parentPaneIds.has(pane.id) ? <ParentMark /> : null}
          {place === null ? null : (
            <span class="hwc-pane-head-space" title={placeTitle}>
              <span class="hwc-pane-head-place">{place.parent}</span>
            </span>
          )}
          {pullRequest === null || pullRequest.state !== "OPEN" ? null : (
            <a
              class="hwc-pane-head-pr"
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              aria-label={pullRequestLabel(pullRequest)}
            >
              #{pullRequest.number}
            </a>
          )}
          <button
            ref={props.files.buttonRef}
            type="button"
            class="hwc-pane-files"
            aria-label={props.files.open ? "ファイルツリーを閉じる" : "ファイルツリーを開く"}
            aria-pressed={props.files.open}
            onClick={() => props.files.onToggle()}
          >
            <FolderIcon size={16} />
            <span class="hwc-pane-files-label">ファイル</span>
          </button>
          <span class="hwc-pane-id" data-copied={props.copy.copied}>
            <span class="hwc-pane-id-text">{pane.id}</span>
            <button
              type="button"
              class="hwc-pane-id-copy"
              aria-label={props.copy.copied ? "コピーしました" : "ペイン ID をコピー"}
              onClick={() => props.copy.onCopy()}
            >
              <CopyGlyph copied={props.copy.copied} />
            </button>
          </span>
          {/* ID の外に置く。中に入れると、hover できる端末で ID と一緒に隠れる。 */}
          <button
            type="button"
            class="hwc-pane-more"
            aria-label={`${pane.id} のメニュー`}
            aria-haspopup="menu"
            aria-expanded={props.paneMenu.open}
            aria-controls={MENU_ID}
            onClick={(event) => props.paneMenu.onOpen(event.currentTarget)}
          >
            <MoreIcon />
          </button>
        </div>
      </div>
      {props.trailing}
    </div>
  );
}
