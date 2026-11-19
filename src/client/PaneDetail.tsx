import { createPortal, type Ref } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatAttachment, ChatFile, ChatMessage, ChatPending } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import type { QuestionAnswer } from "../shared/answer";
import type { FileTreeEntry } from "../shared/file-tree";
import { gitStatusLabel, type GitSync } from "../shared/git";
import {
  attachmentExtFromName,
  attachmentKindOfFileName,
  formatFileSize,
  MAX_ATTACHMENTS,
} from "../shared/attachments";
import { activityLabel, activitySnippet, showActivityFrame, usePaneActivity } from "./activity";
import { OUTPUT_LINES, answerQuestion, attachmentUrl, editMessage, uploadAttachment } from "./api";
import { attachmentStore } from "./attachment-store";
import { FILE_REFERENCE_TYPE, fileReference, insertFileReference } from "./file-reference";
import { fileTreeStore } from "./file-tree-store";
import type { FileTreeSide } from "./file-tree-side";
import { OutputText } from "./OutputText";
import {
  ATTACHMENT_LIMIT_NOTICE,
  type AttachmentAction,
  attachmentTooLargeNotice,
  dropActionFrom,
  exceedsAttachmentLimit,
  pasteActionFrom,
  SEND_FAILED_NOTICE,
  SHELL_BUSY_NOTICE,
  SHELL_NEWLINE_NOTICE,
  STOP_FAILED_NOTICE,
  uploadFailureNotice,
} from "./attachments";
import {
  agentInfo,
  contextMeter,
  idleEchoExpired,
  isPendingConfirmed,
  latestUserAt,
  newSessionPending,
  newSessionReset,
  newSessionSnapshot,
  type NewSessionReset,
  paneBody,
  type PendingMessage,
  PENDING_TURN_GRACE_MS,
  pendingCard,
  usePaneChat,
} from "./chat";
import { isFileTreeShortcut, isInOverlay, isTextEntry } from "./file-tree-key";
import { composerDisabled, enterInsertsNewline } from "./input";
import { useMessageReveal } from "./reveal";
import {
  chipOnInput,
  type CommandId,
  commandAvailable,
  commandBlockReasonFor,
  commandCandidates,
  commandLabel,
  commandSendText,
  commandText,
  COMMAND_BLOCK_NOTES,
  compactAlreadyDone,
  COMPACTED_NOTICE,
  isCompactCommand,
  isCommandPane,
  isNewSessionCommand,
  type PaneOutputHandle,
} from "./commands";
import { ComposerAdd } from "./ComposerAdd";
import { useCopy } from "./copy";
import { insertProjectPath } from "./projects";
import { NewSessionConfirm } from "./NewSessionConfirm";
import { ProjectDialog } from "./ProjectDialog";
import {
  AgentGlyphIcon,
  AgentIcon,
  ArrowDownIcon,
  ChevronDownIcon,
  CloseIcon,
  CollapseIcon,
  CopyGlyph,
  ExpandIcon,
  FolderIcon,
  MoreIcon,
  PaneIcon,
  PencilIcon,
  SendIcon,
  StatusMark,
  StopIcon,
} from "./icons";
import { GitCount } from "./GitCount";
import { MENU_ID } from "./Menu";
import { useElementWidth } from "./app/use-element-width";
import { TREE_SIDE_MIN_WIDTH } from "./layout";
import { usePaneOutput } from "./output";
import { ChatLog } from "./pane/chat-log";
import { OutputEmpty, OutputSkeleton } from "./pane/empty";
import { FilePreview } from "./pane/file-preview";
import { FileTree, type TreeFocusRequest } from "./pane/file-tree";
import { AgentInfoHint, AgentInfoSkeleton, CommandBadge, ContextMeter } from "./pane/info";
import { LiveStatus } from "./pane/live-status";
import { LaunchNote } from "./pane/launch-note";
import { useAttachments } from "./pane/use-attachments";
import { useFilePreview, useFileTree } from "./pane/use-file-tree";
import { useTemplates } from "./pane/use-templates";
import { useCompactionEcho } from "./pane/use-compaction-echo";
import { useDefaultModel } from "./pane/use-default-model";
import { useLaunchModel } from "./pane/use-launch-model";
import { useDraft } from "./pane/use-draft";
import { canEditMessage, editFailureNotice, newRequestId, type EditSession } from "./edit";
import { useOutputFollow } from "./pane/use-output-follow";
import { useOutputVersion } from "./pane/use-output-version";
import { usePreviewReplyBadge } from "./pane/use-preview-reply";
import { useSelectionToolbar } from "./pane/use-selection-toolbar";
import { usePullRequest } from "./pull-request";
import { confirmationView, type ConfirmationAttempt } from "./confirmation";
import { PaneConfirmation } from "./PaneConfirmation";
import { appendQuote, canSend, canStop } from "./reply";
import {
  agentGlyph,
  isShellPane,
  paneName,
  placeChip,
  pullRequestLabel,
  shortenPaneName,
  type PaneContext,
} from "./select";
import { SelectionToolbar } from "./SelectionToolbar";
import { TemplateDialog } from "./TemplateDialog";
import { insertTemplate } from "./templates";
import { formatClock } from "./time";
import { selectionCopyText } from "./selection-copy";
import { Spinner } from "./Spinner";
import { type PaneLaunchView } from "./starting";

const PENDING_TIMEOUT_MS = 60_000;
const NEW_SESSION_TIMEOUT_MS = 60_000;
// ツリーを閉じるアニメーションの長さ。CSS の transition と揃える。
const TREE_CLOSE_MS = 120;
// CSS の transition は次のフレームから始まる。閉じ終える前に unmount しないよう、
// 1 フレーム分だけ待つ。
const TREE_CLOSE_SETTLE_MS = 20;

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type PaneDetailProps = {
  pane: PaneState;
  context: PaneContext;
  compact: boolean;
  // 端末出力の ANSI 色を補正する基準。テーマの解決結果を App から受け取る。
  scheme: "light" | "dark";
  // 広いセルでツリーを会話の左右どちらに並べるか。狭いセルでは重ねるので効かない。
  treeSide: FileTreeSide;
  // 枠線がハイライトしている、操作の対象になっているセルか。キーの対象を 1 つに絞る。
  current: boolean;
  // 分割セルが並ぶときだけ、セルの名前を出す。チップと同じ文字列の繰り返しを避ける。
  labeled: boolean;
  // 複数スペースのペインが並ぶときだけ、見出しに場所を添える（ADR 0019）。
  showSpace: boolean;
  // スペースのブランチ。分割セルでも PR のチップを引くために渡す。
  // 文字として出すかは showBranch が決め、labeled のときは名前を優先する。
  branch: string | null;
  // 一覧が隠れる狭い画面でだけ、ブランチを名前に代えて出す。
  showBranch: boolean;
  // 1 枚表示のときだけ渡す。分割セルは同じ上流の差が並ぶので出さない。
  sync: GitSync | null;
  // push 先のブランチ名。sync は分割セルで null になるが、PR を引く鍵はセルでも要る。
  upstreamBranch: string | null;
  workspaceMenuOpen: boolean;
  waitingMs: number | null;
  // シェルの前景プロセスが動いているか。停止ボタンの出し分けにだけ使う。
  running: boolean;
  sending: boolean;
  // 作ったばかりで起動を頼んだペイン。入力欄の形と送信の可否を決める。
  launch: PaneLaunchView | null;
  dismissedConfirmation: string | null;
  confirmationAttempts: ReadonlyMap<string, ConfirmationAttempt>;
  onConfirmFolderTrust: (id: string) => void;
  onDismissConfirmation: (id: string) => void;
  menuOpen: boolean;
  // クリア後の読み直しだけ、この詳細の実行口を一覧から使う。
  outputRef: Ref<PaneOutputHandle>;
  onOpenMenu: (paneId: string, trigger: HTMLElement) => void;
  onOpenWorkspaceMenu: (workspaceId: string, trigger: HTMLElement) => void;
  onSubmit: (text: string, attachments: string[]) => Promise<boolean>;
  onStop: () => Promise<boolean>;
  // シェルのペインでエージェントを起動する。
  onStartAgent: () => void;
  // 起動に失敗したペインで、同じ指定でもう一度頼む。
  onRetryLaunch: () => void;
  // 起動を諦め、残ったシェルとして使う。
  onUseShell: () => void;
  // 拡大はダイアログで行う。セルの中に置くと containment の内側に閉じる。
  onOpenImage: (url: string, name: string) => void;
  // HTML のプレビューは、タブの 1 つとして会話の外に出す。
  onOpenPreview: (file: ChatFile) => void;
};

export function PaneDetail(props: PaneDetailProps) {
  const {
    pane,
    context,
    compact,
    scheme,
    treeSide,
    current,
    labeled,
    showSpace,
    branch,
    showBranch,
    sync,
    upstreamBranch,
    workspaceMenuOpen,
    waitingMs,
    running,
    sending,
    launch,
    dismissedConfirmation,
    confirmationAttempts,
    onConfirmFolderTrust,
    onDismissConfirmation,
    menuOpen,
    onOpenMenu,
    onOpenWorkspaceMenu,
    onSubmit,
    onStop,
    onOpenImage,
    onOpenPreview,
  } = props;
  const repoUrl = sync?.repoUrl ?? null;
  // ツリーの状態は store に持つ。プレビューでこのセルが外れても開閉を保つ。
  const fileTree = useFileTree(pane.id);
  const previewPath = useFilePreview(pane.id);
  const filesButtonRef = useRef<HTMLButtonElement>(null);
  // 狭いセルで選択したときだけ、プレビューへフォーカスを移す。
  const [previewFocus, setPreviewFocus] = useState<{ focus: boolean }>({ focus: false });
  // ツリーを横に並べるかは、ウィンドウではなく実際のセル幅で決める。狭いセルでは
  // 会話の上に重ねる（ADR 0090）。
  const { ref: widthRef, width: frameWidth } = useElementWidth<HTMLDivElement>();

  // チャットを持たないペインには配信先が無い。store の後始末より先に描かない。
  const treeOpen = pane.chat && fileTree.open;
  const sideBySide = treeOpen && frameWidth !== null && frameWidth >= TREE_SIDE_MIN_WIDTH;
  const treeOverlay = treeOpen && !sideBySide;
  const previewOpen = pane.chat && previewPath !== null;
  // 会話は DOM に残してスクロール位置を保ち、表示だけを差し替える。
  const chatHidden = treeOverlay || previewOpen;

  // 開閉の動きは開いた瞬間だけ。ペインを切り替えて戻ったときは store が開いたままでも
  // 再生しないよう、初期値を store の開閉に合わせる。
  const [treeShown, setTreeShown] = useState(fileTree.open);
  const [treeClosing, setTreeClosing] = useState(false);
  // キーで開いたときだけ、ツリーの行へ焦点を移す。token は開くたびに増え、
  // focus はその開閉がキー由来かを示す。
  const [treeFocus, setTreeFocus] = useState<TreeFocusRequest>({ token: 0, focus: false });
  const treeCloseTimer = useRef<number | null>(null);

  const cancelTreeClose = () => {
    if (treeCloseTimer.current === null) return;
    window.clearTimeout(treeCloseTimer.current);
    treeCloseTimer.current = null;
  };

  // 面を 1 フレーム隠した状態で描いてから表示へ移し、CSS の transition を走らせる。
  useEffect(() => {
    if (!treeOpen || treeShown || treeClosing) return;
    const frame = requestAnimationFrame(() => setTreeShown(true));
    return () => cancelAnimationFrame(frame);
  }, [treeOpen, treeShown, treeClosing]);

  const openTree = (focus: boolean) => {
    cancelTreeClose();
    setTreeClosing(false);
    // token は開くたびに増やし、focus とは別に持つ。番号を戻すと、閉じる途中の
    // 開き直しで前の番号が再利用され、ツリーが処理済みと誤認して焦点を移さない。
    setTreeFocus((request) => ({ token: request.token + 1, focus }));
    // 動きを減らす設定では待たずに出す。CSS も transition を持たない。
    if (prefersReducedMotion()) setTreeShown(true);
    fileTreeStore.open(pane.id);
  };

  // store の close はアニメーションの後。閉じている間は一覧を残したまま inert にし、
  // 消えていく行を押せないようにする。
  const closeTree = () => {
    if (!fileTree.open) return;
    cancelTreeClose();
    if (prefersReducedMotion()) {
      fileTreeStore.close(pane.id);
      setTreeClosing(false);
      setTreeShown(false);
      return;
    }
    setTreeClosing(true);
    setTreeShown(false);
    treeCloseTimer.current = window.setTimeout(() => {
      treeCloseTimer.current = null;
      fileTreeStore.close(pane.id);
      setTreeClosing(false);
      setTreeShown(false);
    }, TREE_CLOSE_MS + TREE_CLOSE_SETTLE_MS);
  };

  // 閉じる途中でセルが外れたら、保留した close を済ませて開いたままにしない。
  useEffect(
    () => () => {
      if (treeCloseTimer.current === null) return;
      window.clearTimeout(treeCloseTimer.current);
      treeCloseTimer.current = null;
      fileTreeStore.close(pane.id);
    },
    [pane.id],
  );

  // 見出しのボタンとキーは同じ経路を通す。store を直接叩くと開閉の動きとずれる。
  // focus はキーで開いたときだけ true。ポインタで開いたときに焦点を飛ばさない。
  const toggleTree = (focus: boolean) => {
    if (treeOpen && !treeClosing) {
      // ツリーの中に焦点があるまま閉じると body に落ちる。行き場を見出しの入口へ返す。
      const active = document.activeElement;
      if (focus && active instanceof Element && active.closest(".hwc-tree-view") !== null) {
        filesButtonRef.current?.focus();
      }
      closeTree();
      return;
    }
    openTree(focus);
  };

  // キーは文書全体で拾う。listener を持つのは対象のセル 1 つだけにする。
  const toggleTreeRef = useRef(toggleTree);
  toggleTreeRef.current = toggleTree;
  useEffect(() => {
    if (!current || !pane.chat) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isFileTreeShortcut(event)) return;
      const focused = document.activeElement instanceof Element ? document.activeElement : null;
      // 入力欄の中では文字を、開いている面の中ではその面のキーを優先する。
      if (isTextEntry(focused) || isInOverlay(focused)) return;
      // 焦点が body にあるときは、最後にクリックしたセル（= current）を開閉する。
      // 他のセルや一覧に焦点があるときは、その画面の操作を横取りしない。
      if (focused !== null && focused !== document.body) {
        const cell = focused.closest("[data-drop-pane]");
        // 分割セルは印で見分ける。1 枚表示はセルの印が無く、詳細の中に PaneDetail が
        // 1 つしか出ないので、詳細の中かどうかだけを見る。
        const inside =
          cell !== null
            ? cell.getAttribute("data-drop-pane") === pane.id
            : focused.closest(".hwc-detail-body") !== null;
        if (!inside) return;
      }
      event.preventDefault();
      toggleTreeRef.current(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, pane.chat, pane.id]);

  // チャットが消えたペインは配信の根を持たない。開いたままにしない。
  useEffect(() => {
    if (pane.chat) return;
    cancelTreeClose();
    fileTreeStore.close(pane.id);
    fileTreeStore.clearPreview(pane.id);
    setTreeClosing(false);
    setTreeShown(false);
  }, [pane.chat, pane.id]);
  const shownPaneName = shortenPaneName(
    paneName(pane),
    context.workspaceLabel,
    context.workspaceName,
  );
  // セルが並ぶときの場所。作成元のスペース → いまのスペースの順に、見出しの名前と
  // 同じ文字列は落とす。どちらも残らないならチップを出さない。
  const place = placeChip(shownPaneName, context.parentSpaceName, context.workspaceName);
  const placeTitle =
    context.parentSpaceLabel === null
      ? `${context.workspaceLabel} / ${context.tabLabel}`
      : `${context.parentSpaceLabel} / ${context.workspaceLabel} / ${context.tabLabel}`;
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { outputVersion, requestOutputRefresh } = useOutputVersion();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [sessionReset, setSessionReset] = useState<NewSessionReset | null>(null);
  // チップは id だけを持つ。表示名と送信文字列は定数から引く。
  const [chip, setChip] = useState<CommandId | null>(null);
  // 編集は対象 id・requestId・本文だけを持つ。下書き (draft) は触らない。
  const [edit, setEdit] = useState<EditSession | null>(null);
  // メニューからの /new だけ、送る前に確認する。
  const [confirmNew, setConfirmNew] = useState(false);
  const attachments = useAttachments(pane.id);
  // + メニューの「定型文を引用」を押せるかだけに使う。読めなければ押せる側に倒す。
  const templates = useTemplates(pane.chat);
  // プロジェクトのダイアログは閉じるアニメーションの間も残す。caret は選んだ直後に
  // 入力欄へ戻す位置で、閉じただけ（キャンセル）のときは null のまま。
  const [projectDialog, setProjectDialog] = useState<{
    open: boolean;
    caret: number | null;
  } | null>(null);
  // 定型文のダイアログも、閉じるアニメーションの間は残す。caret は選んだ直後に
  // 入力欄へ戻す位置で、閉じただけのときは null のまま。
  const [templateDialog, setTemplateDialog] = useState<{
    open: boolean;
    caret: number | null;
  } | null>(null);
  // ファイルをドラッグしている間だけ composer を光らせる。dragenter / dragleave は
  // 子要素をまたぐたびに入れ替わるので、深さを数えて枠から出たときだけ消す。
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  // 簡略中は expanded を効かせない。状態は書き換えないので、通常の高さに戻れば再び効く。
  const expanded = expandedOpen && !compact;

  // 要対応の間は端末を見たいので、会話の取得も止める。戻ったらその場で取り直す。
  // ただし Claude の要対応は質問・承認の待ちで、内容は transcript にある。応答待ちを出す
  // ために、blocked の間も 5 秒間隔（chatPollDelay の idle と同じ）で読み続ける。
  const blocked = pane.agentStatus === "blocked";
  const {
    snapshot: serverSnapshot,
    failed: chatFailed,
    refresh: refreshChat,
  } = usePaneChat(
    pane.id,
    pane.chat,
    pane.chat && (!blocked || pane.agent === "claude"),
    pane.agentStatus,
  );
  // 実行中の段階は pi 拡張の sidecar、Claude は transcript の進行行から取る（ADR 0035 / 0100）。
  // blocked の間も hook は生かしたままにする。状態の遷移で保持値を捨て、取得は working の
  // 間だけに限る（blocked で effect を外すと、同じターンに戻ったとき古い段階が一瞬出る）。
  const activity = usePaneActivity(
    pane.id,
    (pane.agent === "pi" || pane.agent === "claude") && pane.chat,
    pane.agentStatus,
    pane.agent === "claude",
  );
  // 分割セルも含め、見出しごとに引く。同じスペースのセルは同じ PR になる。
  const pullRequest = usePullRequest(context.workspaceId, branch, upstreamBranch);
  const resetting = sessionReset !== null && newSessionPending(sessionReset, serverSnapshot);
  const snapshot = resetting ? newSessionSnapshot(serverSnapshot) : serverSnapshot;
  // 応答待ちのカードと、そこから切り替える端末出力。どの tool_use に対して開いたかだけを
  // 覚える。pending が変われば会話へ戻り、消えたあとに古い切り替えも残らない。
  const pendingView = pendingCard(snapshot, blocked);
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  const showTerminal = pendingView !== null && terminalFor === pendingView.toolUseId;
  // 回答の結果に関わらず、5 秒の取得を待たずに会話を読み直す。成功なら質問が消え、失敗でも
  // 質問が既に無かったなら（409）カードがすぐ消える。
  const answerQuestionAndRefresh = async (
    target: Extract<ChatPending, { kind: "question" }>,
    answers: QuestionAnswer[],
  ) => {
    const result = await answerQuestion(pane.id, { toolUseId: target.toolUseId, answers });
    refreshChat();
    return result;
  };
  const editTarget =
    edit === null
      ? null
      : (snapshot?.messages.find((message) => message.id === edit.messageId) ?? null);
  const normalBody = paneBody({
    chat: pane.chat || resetting,
    blocked,
    failed: chatFailed && !resetting,
    snapshot,
    showTerminal,
  });
  const pendingMessages = pending.filter(
    (item) =>
      (!resetting || sessionReset === null || item.at >= sessionReset.at) &&
      !isPendingConfirmed(item, snapshot?.messages ?? []),
  );

  useEffect(() => {
    if (sessionReset === null) return;
    // TUI コマンドの成否は返らないため、反映されなければサーバーの表示へ戻す。
    const timer = window.setTimeout(
      () => setSessionReset(null),
      Math.max(0, sessionReset.at + NEW_SESSION_TIMEOUT_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [sessionReset]);

  const { read, failed } = usePaneOutput(
    pane.agent === "codex" || normalBody.kind === "output" ? pane.id : null,
    outputVersion,
  );
  const interaction = read?.interaction ?? null;
  const view = confirmationView({ pane, interaction, dismissedId: dismissedConfirmation, failed });
  const readOnly = view !== "normal";
  // 入力欄を閉じるか。folder trust の readOnly と、Claude の blocked（質問・権限確認の
  // 待ち）を同じ扱いにする。readOnly と違い、Claude の blocked は本文を端末出力のまま
  // にして、ダイアログへの入力漏れだけを塞ぐ。
  const inputDisabled = composerDisabled(pane, readOnly);
  const body = readOnly ? { kind: "output" as const } : normalBody;
  const previewHasNewReply = usePreviewReplyBadge(
    previewOpen,
    body.kind === "chat" ? body.snapshot.messages : null,
  );
  // 新しく届いた返答を一度に描くと、長いときに先頭がスクロールの外へ流れる。
  // 演出は会話を出している間だけ。初期表示と入れ替えでは再生しない。
  // /new のマスク中は空の表示用スナップショットなので、比較させない。渡すと
  // マスクが解けて元の会話へ戻るときに末尾の返答を追記と誤認する。
  const reveal = useMessageReveal(resetting || body.kind !== "chat" ? null : body.snapshot);
  // 起動を頼んだペインは、スナップショットがエージェントを示す前でもエージェント仕様で扱う。
  // 起動中は送信・添付・コマンドを受け付けず、準備ができたら送信を開ける。
  const launchPending = launch !== null && launch.phase !== "ready";
  const launching = launch?.phase === "launching" && !readOnly;
  const launchBlocked = launchPending && !readOnly;
  const confirmation =
    view === "confirm" && interaction?.kind === "folder-trust" ? interaction : null;
  const output = read?.text ?? null;
  const outputEmpty = output !== null && output.trim() === "";
  const replying = pane.agentStatus === "working";
  // /compact の開始を観測できたときだけ、完了までの所要時間をログに添える。
  // リロードやペイン切り替えでは失う（永続化は別スコープ）。
  const compactionAt = snapshot?.compaction?.at ?? null;
  const {
    compactionRun,
    compactionEcho,
    compactionDuration,
    compactionElapsedMs,
    markCompaction,
    clearCompaction,
    resetCompaction,
  } = useCompactionEcho({ compactionAt, replying });
  const compacting = !resetting && compactionRun !== null;
  const visibleCompactionEcho = resetting ? null : compactionEcho;
  const chatEmpty =
    body.kind === "chat" &&
    body.snapshot.messages.length === 0 &&
    body.snapshot.compaction === null &&
    pendingMessages.length === 0 &&
    pendingView === null &&
    !compacting &&
    visibleCompactionEcho === null &&
    !replying;
  const empty =
    !launching && (body.kind === "chat" ? chatEmpty : body.kind === "output" && outputEmpty);
  const launchInfo =
    launch === null || (launch.model === null && launch.effort === null)
      ? null
      : { model: launch.model === null ? null : launch.model.id, effort: launch.effort };
  const snapshotInfo = agentInfo(snapshot);
  // 既定モデルで起動した pi は、会話にモデルが載るまで何も出せない。チャット画面を
  // 開いている間だけ既定を読み、スケルトンで待ちを示す（ADR 0087）。
  const defaultInfo = useDefaultModel(
    pane.id,
    pane.agent === "pi" &&
      pane.chat &&
      !readOnly &&
      body.kind === "chat" &&
      snapshot !== null &&
      snapshotInfo === null &&
      launchInfo === null,
  );
  // 会話を読めないペインは、hwc が預かっている起動時の指定でモデルを補う（ADR 0101）。
  const launchModelInfo = useLaunchModel(
    pane.id,
    pane.chat &&
      !readOnly &&
      snapshotInfo === null &&
      launchInfo === null &&
      defaultInfo.info === null,
  );
  const info = snapshotInfo ?? launchInfo ?? defaultInfo.info ?? launchModelInfo;
  const infoLoading = info === null && defaultInfo.loading;
  // モデルと effort が無くても、コンテキストの材料があれば行を出す。
  const meter = contextMeter(snapshot?.context ?? null);
  const content = body.kind === "chat" ? body.snapshot.messages : output;

  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // 引用を足した直後、再描画後の入力欄へカーソルを移す位置。
  const pendingCaret = useRef<number | null>(null);
  // ツリーの行を掴むと入力欄からフォーカスが外れる。その直前の選択範囲を控え、
  // 落としたときの差し込み位置にする。一度もフォーカスしていなければ null。
  const lastSelection = useRef<{ start: number; end: number } | null>(null);
  // 開閉を押した時点の入力欄の高さ。開閉後の高さへ動かす始点にする。
  const toggleFrom = useRef<number | null>(null);
  // 実行中の開閉アニメーション。高さを測る前に止める。
  const heightAnimation = useRef<Animation | null>(null);
  const { selectionToolbar, quoting, dismissSelection, closeToolbar } = useSelectionToolbar({
    paneId: pane.id,
    scroller,
    frame,
  });

  const shell = isShellPane(pane) && launch === null;
  // シェルには会話のコマンドが無い。エージェントを終了したときにチップが残っていても、
  // シェルの入力欄では見せず、送信も本文として扱う。
  const activeChip = shell ? null : chip;
  const { draft, setDraft, clearDraft } = useDraft(pane.id, activeChip !== "compact");
  const inputText = edit === null ? draft : edit.text;
  // 編集中は入力欄の値を編集本文へ流し、下書きはそのまま残す。
  const setInputText = (value: string) => {
    if (edit !== null) {
      setEdit((current) => (current === null ? current : { ...current, text: value }));
      return;
    }
    setDraft(value);
    setChip(chipOnInput(activeChip));
  };
  const compactDone = snapshot !== null && compactAlreadyDone(snapshot);
  // 添付を持っている間は候補を出さない。候補を選ぶと本文が消えるので、貼った画像と
  // 書きかけの指示が別々のメッセージに分かれてしまう。引用は下書きの一部なので、
  // 本文の先頭が `/` でなければ候補は出ない。空の会話と圧縮済みは commandAvailable が見る。
  // 起動中も出すと、選んだ時点で下書きがチップに変わり消える。準備ができるまで出さない。
  const candidates =
    edit === null &&
    !launchBlocked &&
    !inputDisabled &&
    attachments.length === 0 &&
    compactionRun === null
      ? commandCandidates(pane, draft, snapshot)
      : [];
  const uploading = attachments.some((item) => item.name === null);
  const editSendable =
    edit !== null && edit.text.trim() !== "" && pane.agentStatus !== "working" && !edit.sending;
  const sendable =
    edit !== null
      ? editSendable
      : canSend({
          uploading,
          chip: activeChip,
          replying,
          draft,
          attachments: attachments.length,
        });
  const sendingAny = sending || edit?.sending === true;
  // 停止は入力が空のときだけ出す。文字・添付・引用があれば、送信は実行中への追加指示になる。
  const stop =
    edit === null &&
    canStop({
      replying,
      agent: pane.agent,
      running,
      draft,
      attachments: attachments.length,
      chip: activeChip,
    });
  const busy = sendingAny || stopping;
  const placeholder =
    edit !== null
      ? "この発言を編集"
      : activeChip === "compact"
        ? "圧縮の指示（任意）"
        : shell
          ? "コマンドを入力"
          : "メッセージを入力";
  // 圧縮のチップ中は入力欄が指示になる。長い定型文を引用する先ではない。
  const templateBlock =
    edit === null && activeChip === "compact" ? "圧縮の指示には使えません" : null;

  // シェルに戻ったら、会話のコマンドチップは持ち越さない。残すと、シェルへ
  // /compact を送ってしまい、次の会話に圧縮の控えが並ぶ。
  useEffect(() => {
    if (!shell) return;
    setChip((current) => (current === null ? current : null));
  }, [shell]);

  // 作ったペインは、閉じたダイアログの続きでそのまま打ち始められるように焦点を移す。
  // iOS は非同期の後にキーボードを出さないことがあるので、焦点だけを合わせる。
  useEffect(() => {
    if (launch === null || launch.phase !== "launching") return;
    input.current?.focus();
  }, [launch === null ? null : launch.phase]);

  const { copiedId, copy } = useCopy();
  const copied = copiedId === "pane";
  const copyId = () => copy("pane", pane.id);

  // 前景でコマンドが動いていると Herdr は起動を受け付けない。先に止めてもらう。
  const startAgent = () => {
    if (running) {
      setNotice(SHELL_BUSY_NOTICE);
      return;
    }
    props.onStartAgent();
  };

  // 入力量に合わせて高さを伸ばす。広げている間は CSS の高さに任せる。
  // 簡略表示では入力欄と情報・送信を同じ行に置くが、折り返して 2 行以上になったら
  // 入力欄を読み幅いっぱいに広げたい。広い幅で 1 行に戻ると狭い幅で再び折り返し、
  // 行の往復が起きるので、空にするまで広い側を保つ。
  const fit = (field: HTMLTextAreaElement | null, open: boolean) => {
    if (!field) return;
    // アニメーション中の rect と scrollHeight は途中の高さになる。計測の前に止める。
    heightAnimation.current?.cancel();
    heightAnimation.current = null;
    const form = field.closest(".hwc-input");
    field.style.height = "";
    if (open) {
      form?.removeAttribute("data-wrapped");
      return;
    }
    field.style.height = "auto";
    const style = getComputedStyle(field);
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    const oneLine = Math.max(
      line + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
      Number.parseFloat(style.minHeight) || 0,
    );
    if (compact && field.value !== "" && field.scrollHeight > oneLine + 1) {
      form?.setAttribute("data-wrapped", "");
    } else if (!compact || field.value === "") {
      form?.removeAttribute("data-wrapped");
    }
    // 属性を変えると入力欄の幅も変わるので、その後の高さで合わせる。
    field.style.height = `${field.scrollHeight}px`;
  };

  // 送信で空にしたときも、高さを初期状態へ戻す。分割枚数が変わって簡略が切り替わったときも、
  // 前の inline height を残さない。
  // 描画の後に高さを直すと、改行した 1 フレームだけ箱が低いままになり、
  // スクロールバーが一瞬出る。描画の前に合わせる。
  useLayoutEffect(() => {
    fit(input.current, expanded);
  }, [inputText, expanded, compact, inputDisabled]);

  // 高さが変わるのは開閉を押したときだけにする。打鍵に合わせた伸縮まで滑らせると、
  // 1 文字ごとに箱が動いて入力の手応えが鈍る。
  useLayoutEffect(() => {
    const field = input.current;
    const from = toggleFrom.current;
    toggleFrom.current = null;
    if (field === null || from === null) return;
    const to = field.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    heightAnimation.current = field.animate(
      [
        // min-height / max-height も一緒に動かす。状態ごとの制約が残ると、始点の高さが
        // その範囲へ切り詰められて 1 フレーム目で跳ぶ（開: 42→64px、閉: 293→220px）。
        { height: `${from}px`, minHeight: `${from}px`, maxHeight: `${from}px` },
        { height: `${to}px`, minHeight: `${to}px`, maxHeight: `${to}px` },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [expanded]);

  const toggleExpanded = () => {
    toggleFrom.current = input.current?.getBoundingClientRect().height ?? null;
    setExpandedOpen((current) => !current);
  };

  // 引用を足したあと、再描画された入力欄の末尾（引用の後の空行）へカーソルを移す。
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(caret, caret);
    fit(field, expanded);
  }, [draft, expanded]);

  useLayoutEffect(() => {
    if (confirmation !== null && scroller.current) scroller.current.scrollTop = 0;
  }, [confirmation?.id]);

  const { atBottom, setPinned, jumpToLatest, onScroll } = useOutputFollow({
    scroller,
    quoting,
    outputRef: props.outputRef,
    requestOutputRefresh,
    content,
    replying,
    pendingCount: pendingMessages.length,
    revealLength: reveal?.text.length,
    notice,
    compactionRun,
    compactionEcho,
    confirmation,
  });

  useEffect(() => {
    if (pending.length === 0) return;
    const messages = snapshot?.messages ?? [];
    setPending((items) => {
      const next = items.filter((item) => !isPendingConfirmed(item, messages));
      return next.length === items.length ? items : next;
    });
  }, [snapshot, pending.length]);

  useEffect(() => {
    if (replying) return;
    setPending((items) => {
      const next = items.filter((item) => !item.waiting);
      return next.length === items.length ? items : next;
    });
  }, [replying, pending.length]);

  // 送信したのにエージェントが動き出さない echo は、TUI がコマンドとして処理したか、
  // 入力を受け取らなかったものとして、ローカルのコマンド控えに切り替える。コマンドは
  // user 発話を残さないため、セッションを待っても確定しない。
  useEffect(() => {
    const idle = pending.filter((item) => !item.waiting && !item.command);
    if (idle.length === 0 || replying) return;
    const oldest = Math.min(...idle.map((item) => item.at));
    const delay = Math.max(0, oldest + PENDING_TURN_GRACE_MS - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      setPending((items) => {
        let changed = false;
        const next = items.map((item) => {
          if (item.command || !idleEchoExpired(item, now)) return item;
          changed = true;
          return { ...item, command: true };
        });
        return changed ? next : items;
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [pending, replying]);

  useEffect(() => {
    const idle = pending.filter((item) => !item.waiting && !item.command);
    if (idle.length === 0) return;
    const oldest = Math.min(...idle.map((item) => item.at));
    const delay = Math.max(0, oldest + PENDING_TIMEOUT_MS - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      setPending((items) =>
        items.filter((item) => item.command || item.waiting || item.at + PENDING_TIMEOUT_MS > now),
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [pending]);

  // 候補を選ぶとチップになり、入力欄の /... は消える。送信はもう一度 Enter。
  // 起動中は候補を出さないが、古い描画からのクリックでも下書きを消さない。
  const pick = (id: CommandId) => {
    if (launchBlocked || inputDisabled || edit !== null) return;
    setChip(id);
    setDraft("");
    // タップでキーボードが閉じないよう、入力欄へ焦点を戻す。
    input.current?.focus();
  };

  const clearChip = () => {
    if (edit !== null) return;
    setChip(null);
    setDraft("");
    input.current?.focus();
  };

  // 選択を引用として下書きの末尾へ足す。compact のチップは外すが、指示の下書きは残す
  // （引用に続く本文として送り、/compact には戻さない。ADR 0016 / 0062）。
  const quoteSelection = () => {
    // 送信中に足すと、成功時のクリアで新しい引用まで消える。送っている間は受け付けない。
    if (sendingAny || launchBlocked || inputDisabled) return;
    const text = selectionToolbar?.anchor.text ?? "";
    if (text === "") return;
    const next = appendQuote(inputText, text);
    setInputText(next.text);
    if (edit === null) setChip(null);
    pendingCaret.current = next.caret;
    dismissSelection();
  };

  const openProjects = () => setProjectDialog({ open: true, caret: null });

  const closeProjects = () =>
    setProjectDialog((current) => (current === null ? null : { ...current, open: false }));

  // 選んだプロジェクトは本文のカーソル位置へ入れる。チップは文字を打ったときと同じ規則で、
  // new は解除し、compact の指示は残す。
  const pickProject = (path: string) => {
    const field = input.current;
    const start = field?.selectionStart ?? inputText.length;
    const end = field?.selectionEnd ?? start;
    const next = insertProjectPath(inputText, start, end, path);
    setInputText(next.text);
    if (edit === null) setChip(chipOnInput(activeChip));
    setProjectDialog({ open: false, caret: next.caret });
  };

  // キャンセル時は DialogShell が開く前の要素（+ ボタン）へ戻す。選んだときだけ、
  // 閉じるアニメーションの後に本文へフォーカスを移す。
  const projectsExited = () => {
    const caret = projectDialog?.caret ?? null;
    setProjectDialog(null);
    if (caret === null) return;
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(caret, caret);
    fit(field, expanded);
  };

  const openTemplates = () => setTemplateDialog({ open: true, caret: null });

  const closeTemplates = () =>
    setTemplateDialog((current) => (current === null ? null : { ...current, open: false }));

  // 選んだ本文はカーソル位置へ入れる。チップは文字を打ったときと同じ規則で、
  // new は解除し、compact の指示は残す。
  const pickTemplate = (body: string) => {
    const field = input.current;
    const start = field?.selectionStart ?? inputText.length;
    const end = field?.selectionEnd ?? start;
    const next = insertTemplate(inputText, start, end, body);
    setInputText(next.text);
    if (edit === null) setChip(chipOnInput(activeChip));
    setTemplateDialog({ open: false, caret: next.caret });
  };

  // キャンセル時は DialogShell が開く前の要素（+ ボタン）へ戻す。選んだときだけ、
  // 閉じるアニメーションの後に本文へフォーカスを移す。
  const templatesExited = () => {
    const caret = templateDialog?.caret ?? null;
    setTemplateDialog(null);
    if (caret === null) return;
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(caret, caret);
    fit(field, expanded);
  };

  // ツリーの行を composer へ落としたとき、そのパスを下書きの選択位置へ入れる。
  // 末尾ではなくキャレットへ入れるので、指示の途中に複数並べられる。
  const insertReference = (reference: string) => {
    const recorded = lastSelection.current;
    const start = recorded?.start ?? inputText.length;
    const end = recorded?.end ?? start;
    const next = insertFileReference(inputText, start, end, reference);
    // 同じパスを選択範囲に落とすと下書きが変わらず、再描画後のキャレットを戻す
    // layout effect が走らない。そのときは、その場で入力欄へ戻す。
    if (next.text === inputText) {
      const field = input.current;
      if (field === null) return;
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
      return;
    }
    setInputText(next.text);
    pendingCaret.current = next.caret;
  };

  // 外した添付は送らない。進行中のアップロードも止める。保存先のファイルは消さない。
  const removeAttachment = (key: string) => attachmentStore.remove(pane.id, key);

  // ペインを切り替えても止めない。送り先が消えたときだけ App が中断する。
  const uploadFile = async (file: File) => {
    const { key, controller } = attachmentStore.begin(pane.id, file.size);

    const result = await uploadAttachment(pane.id, file, controller.signal);
    if (result.ok) {
      attachmentStore.settle(pane.id, key, result.name);
      return;
    }
    // 外された添付は一覧から既に消えている。その失敗は知らせない。
    if (controller.signal.aborted) return;
    attachmentStore.remove(pane.id, key);
    setNotice(uploadFailureNotice(result.status, attachmentKindOfFileName(file.name)));
  };

  // 貼ったファイルを見たらコマンドではなく本文を書く。書きかけの draft は捨てない。
  // 上限を超えるものは送る前に弾く。
  const addFiles = (files: File[]) => {
    if (launchBlocked || inputDisabled || edit !== null) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setNotice(ATTACHMENT_LIMIT_NOTICE);
      return;
    }
    if (files.length > room) setNotice(ATTACHMENT_LIMIT_NOTICE);
    setChip(null);
    for (const file of files.slice(0, room)) {
      if (exceedsAttachmentLimit(file)) {
        setNotice(attachmentTooLargeNotice(attachmentKindOfFileName(file.name)));
        continue;
      }
      void uploadFile(file);
    }
  };

  // OS から落としたファイルと、ツリーの行を運んだドロップを同じ受け口で扱う。
  // dragover 中は getData を読めない（保護モード）ので、種類は型だけで決める。
  const dropKind = (transfer: DataTransfer | null): "files" | "reference" | null => {
    if (transfer === null) return null;
    if (transfer.types.includes(FILE_REFERENCE_TYPE)) return "reference";
    if (transfer.types.includes("Files")) return "files";
    return null;
  };

  // 貼り付けとドロップで同じ受け付け方をする。アップロードするファイルが無ければ
  // 既定動作を止めない（ADR 0018）。何もアップロードしないときは false を返す。
  const takeFiles = (action: AttachmentAction): boolean => {
    if (action.kind !== "upload") return false;
    addFiles(action.files);
    return true;
  };

  const startsNewSession = (text: string, names: readonly string[]) =>
    (pane.chat || serverSnapshot !== null) &&
    names.length === 0 &&
    isCommandPane(pane) &&
    isNewSessionCommand(text);

  // 送った本文を、ポーリングが返すまでの控えとして積む。入力欄からの送信と、会話の行から
  // 送る依頼で形を揃える。
  const echoPending = (echo: {
    text: string;
    at: number;
    from: number;
    waiting: boolean;
    after: number;
    attachments: ChatAttachment[];
  }) => {
    setPending((items) => [
      ...items,
      {
        id: `pending-${echo.at}-${items.length}`,
        role: "user",
        text: echo.text,
        at: echo.at,
        from: echo.from,
        waiting: echo.waiting,
        after: echo.after,
        command: false,
        ...(echo.attachments.length === 0 ? {} : { attachments: echo.attachments }),
      },
    ]);
  };

  const submitInput = async (text: string, names: string[]): Promise<boolean> => {
    const newSession = startsNewSession(text, names);
    if (newSession) setSessionReset(newSessionReset(serverSnapshot, Date.now()));
    const sent = await onSubmit(text, names);
    if (newSession) {
      if (sent) {
        setPending([]);
        resetCompaction();
      } else setSessionReset(null);
      refreshChat();
    }
    return sent;
  };

  // 過去の発言を入力欄へ移す。下書きはそのまま残し、編集中だけ別の本文を使う。
  const startEdit = (message: ChatMessage) => {
    if (edit !== null || inputDisabled || launchBlocked) return;
    setNotice(null);
    setChip(null);
    setEdit({
      messageId: message.id,
      requestId: newRequestId(),
      text: message.text,
      sending: false,
    });
    requestAnimationFrame(() => {
      const field = input.current;
      if (field === null) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  };

  const cancelEdit = () => {
    if (edit === null || edit.sending) return;
    setEdit(null);
    setNotice(null);
    input.current?.focus();
  };

  const sendEdit = async () => {
    if (edit === null || edit.sending || inputDisabled || launchBlocked) return;
    if (edit.text.trim() === "") return;
    if (pane.agentStatus === "working") {
      setNotice("実行中は編集できません");
      return;
    }
    const pendingEdit = { ...edit, sending: true };
    setNotice(null);
    input.current?.blur();
    setEdit(pendingEdit);
    const result = await editMessage(
      pane.id,
      pendingEdit.messageId,
      pendingEdit.requestId,
      pendingEdit.text,
    );
    if (result.ok) {
      setEdit(null);
      setPinned(true);
      refreshChat();
      return;
    }
    setEdit((current) => (current === null ? current : { ...current, sending: false }));
    setNotice(editFailureNotice(result.error, result.rewound));
    if (result.rewound) refreshChat();
  };

  const sendText = async () => {
    if (edit !== null) {
      void sendEdit();
      return;
    }
    if (inputDisabled || launchBlocked || !sendable || sending) return;
    const names = attachments
      .map((item) => item.name)
      .filter((name): name is string => name !== null);
    // 控えのチップは手元の File のサイズで描く。次のスナップショットで実バイト数に置き換わる。
    const echoed: ChatAttachment[] = attachments.flatMap((item) =>
      item.name === null ? [] : [{ name: item.name, size: item.size }],
    );
    const text = draft;
    // 添付があると BFF が注記を後ろに付けるので、pi では /compact でもコマンドにならない。
    const compactCommand = attachments.length === 0 && isCompactCommand(text);
    const newCommand = startsNewSession(text, names);
    if (compactCommand && compactDone) {
      setNotice(COMPACTED_NOTICE);
      return;
    }
    const baselineAt = snapshot?.compaction?.at ?? null;
    const from = latestUserAt(snapshot?.messages ?? []);
    const waiting = replying;
    const after = snapshot?.messages.length ?? 0;
    // 送信したらキーボードを閉じて出力を見せる。
    input.current?.blur();
    // 前の失敗は消す。送り直したのに前の notice が残っていると、いつの結果か読めない。
    setNotice(null);
    // 送れたときだけ空にする。失敗したら本文も添付も残す。
    if (await submitInput(text, names)) {
      // 猶予は送信が通った時点から測る。POST が遅いときに、届く前の echo を畳まない。
      const at = Date.now();
      // 送れたときだけ最新へ戻す。失敗したら読み返していた位置を保つ。
      setPinned(true);
      clearDraft();
      attachmentStore.clear(pane.id);
      // シェルペインには会話が無い。控えを積むと、同じペインで後から起動した
      // エージェントの会話に、シェルで打ったコマンドが並ぶ。送信は端末にだけ届ける。
      if (!shell) {
        // /compact は user メッセージを残さない。送信カードを積むと最大 60 秒残るので、
        // 代わりに圧縮中の行を出す。
        if (compactCommand) {
          markCompaction(baselineAt, text);
        } else if (!newCommand) {
          echoPending({ text, at, from, waiting, after, attachments: echoed });
        }
      }
    } else {
      setNotice(SEND_FAILED_NOTICE);
    }
  };

  const stopWorking = async () => {
    if (stopping || !stop) return;
    setStopping(true);
    setNotice(null);
    if (!(await onStop())) setNotice(STOP_FAILED_NOTICE);
    setStopping(false);
  };

  // 手動 compaction は Herdr の working にならないため、失敗しても agent_status から
  // 判別できない。10 分の上限だけに頼らず、進捗行から Esc を送ってローカルの開始記録を
  // 畳めるようにする。
  const cancelCompaction = async () => {
    if (stopping) return;
    setStopping(true);
    setNotice(null);
    if (await onStop()) {
      clearCompaction();
    } else setNotice(STOP_FAILED_NOTICE);
    setStopping(false);
  };

  // /new は user 発話を残さないので、送信中バブルを積むと最大 60 秒残る。
  // compact は draft を指示として後ろに付ける。送れたときだけ両方空にする。
  const sendCommand = async (id: CommandId) => {
    if (edit !== null) return;
    if (inputDisabled || launchBlocked || sending || replying || compactionRun !== null) return;
    if (id === "compact" && compactDone) {
      setNotice(COMPACTED_NOTICE);
      return;
    }
    const text = commandSendText(id, draft);
    const baselineAt = snapshot?.compaction?.at ?? null;
    input.current?.blur();
    setNotice(null);
    if (await submitInput(text, [])) {
      setPinned(true);
      setChip(null);
      setDraft("");
      if (id === "compact") markCompaction(baselineAt, text);
    } else setNotice(SEND_FAILED_NOTICE);
  };

  // メニューからはコマンド文字列だけを送る。書きかけの draft・添付は次の
  // メッセージのために残す（チップのように draft を指示には使わない）。
  const menuCommandAvailable = (id: CommandId): boolean =>
    edit === null &&
    !inputDisabled &&
    !launchBlocked &&
    !sending &&
    compactionRun === null &&
    commandAvailable(id, pane, snapshot);

  const runMenuCommand = async (id: CommandId) => {
    if (edit !== null || !menuCommandAvailable(id)) return;
    const text = commandText(id);
    const baselineAt = snapshot?.compaction?.at ?? null;
    input.current?.blur();
    setNotice(null);
    if (await submitInput(text, [])) {
      setPinned(true);
      setChip(null);
      if (id === "compact") markCompaction(baselineAt, text);
    } else setNotice(SEND_FAILED_NOTICE);
  };

  const menuCommandHint = (id: CommandId): string => {
    if (sending) return "送信中は使えません";
    if (compactionRun !== null) return "圧縮中は使えません";
    if (pane.agentStatus === "working") return "実行中は使えません";
    const reason = commandBlockReasonFor(id, snapshot);
    if (reason !== null) return COMMAND_BLOCK_NOTES[reason];
    return id === "new" ? "このペインで会話を始め直す" : "履歴を要約して縮める";
  };

  const composerCommands = isCommandPane(pane)
    ? {
        newSession: {
          label: commandLabel("new"),
          available: menuCommandAvailable("new"),
          hint: menuCommandHint("new"),
          run: () => {
            if (menuCommandAvailable("new")) setConfirmNew(true);
          },
        },
        compact: {
          label: commandLabel("compact"),
          available: menuCommandAvailable("compact"),
          hint: menuCommandHint("compact"),
          run: () => void runMenuCommand("compact"),
        },
      }
    : null;

  const submit = () => {
    if (inputDisabled || launchBlocked) return;
    if (edit !== null) {
      void sendEdit();
      return;
    }
    // 添付中は候補にもチップにも流さない。
    if (attachments.length === 0) {
      if (activeChip !== null) {
        void sendCommand(activeChip);
        return;
      }
      const first = candidates[0];
      if (first !== undefined) {
        pick(first);
        return;
      }
    }
    void sendText();
  };

  // 圧縮中は hwc のローカル表示が正。拡張の段階と重ねない。
  const livePhase = compacting || activity === null ? null : activityLabel(activity);
  const liveThought = compacting || activity === null ? "" : activitySnippet(activity.text);
  // 低いセルは ADR 0035 のとおり段階と経過時間だけにする。速度は通常セルでだけ出す。
  const liveTokPerSecond =
    compacting || compact || activity === null ? null : activity.tokPerSecond;

  const closePreview = () => {
    fileTreeStore.clearPreview(pane.id);
    // 閉じた後にフォーカスが body へ落ちないよう、ツリーの入口へ戻す。
    filesButtonRef.current?.focus();
  };

  // 行のドラッグは、プレビューの「パスをコピー」と同じ文字列を運ぶ。ツリーの根は
  // スペースのチェックアウトで、ペインの cwd とは限らない（ADR 0056 / 0095）。
  const startTreeDrag = (event: DragEvent, entry: FileTreeEntry) => {
    const transfer = event.dataTransfer;
    if (transfer === null) return;
    transfer.setData(
      FILE_REFERENCE_TYPE,
      fileReference(props.context.workspacePath, entry.path, entry.kind === "dir"),
    );
    transfer.effectAllowed = "copy";
  };

  // 広いセルでは会話の左右どちらか（設定で選ぶ）、狭いセルでは会話の上に重ねる。
  // 同じ要素をどちらか一方にだけ置く。
  const treeView = treeOpen ? (
    <FileTree
      paneId={pane.id}
      view={fileTree}
      side={sideBySide}
      shown={treeShown}
      closing={treeClosing}
      focusRequest={treeFocus}
      selectedPath={previewPath}
      onToggle={(path) => fileTreeStore.toggle(pane.id, path)}
      onRetry={(path) => fileTreeStore.retry(pane.id, path)}
      onSelectFile={(path) => {
        fileTreeStore.selectFile(pane.id, path);
        // 狭いセルではツリーが会話を覆う。選んだら閉じて、プレビューを見せる。
        // 同じファイルを選び直してもフォーカスが body に落ちないよう、選択ごとに要求する。
        setPreviewFocus({ focus: !sideBySide });
        if (!sideBySide) closeTree();
      }}
      onOpenImage={onOpenImage}
      onDragStart={startTreeDrag}
    />
  ) : null;

  // 並べたツリーの見出し。空いている 260px を、選択中ファイルの在り処に使う。
  // 未選択なら何も指していないので空のままにする。長さは CSS が列幅で詰め、
  // 末尾のファイル名が残る。全文は title に置く。
  const treeHead = sideBySide ? (
    <span
      class="hwc-pane-head-tree"
      data-edge={treeSide}
      data-shown={treeShown ? "true" : "false"}
      data-closing={treeClosing ? "true" : undefined}
    >
      {previewPath === null ? null : (
        <span class="hwc-pane-head-tree-path" title={previewPath}>
          <bdi>{previewPath}</bdi>
        </span>
      )}
    </span>
  ) : null;

  return (
    <>
      <div class="hwc-pane-head" data-bare={!labeled}>
        {sideBySide && treeSide === "left" ? treeHead : null}
        <div class="hwc-pane-head-main">
          <div class="hwc-pane-head-content">
            <span class="hwc-pane-head-icon" data-agent={agentGlyph(pane.agent)}>
              {pane.agent ? (
                <AgentGlyphIcon agent={pane.agent} size={14} />
              ) : (
                <PaneIcon size={14} />
              )}
            </span>
            {labeled ? (
              <span class="hwc-pane-head-name">{shownPaneName}</span>
            ) : showBranch ? (
              branch === null ? null : (
                <button
                  type="button"
                  class="hwc-pane-head-branch-menu"
                  aria-label={`${branch} のスペースメニュー${sync === null ? "" : `、${gitStatusLabel(sync)}`}`}
                  aria-haspopup="menu"
                  aria-expanded={workspaceMenuOpen}
                  aria-controls={MENU_ID}
                  data-open={workspaceMenuOpen}
                  onClick={(event) => onOpenWorkspaceMenu(context.workspaceId, event.currentTarget)}
                >
                  <span class="hwc-pane-head-branch" title={branch}>
                    {branch}
                  </span>
                  <GitCount sync={sync} />
                  <span class="hwc-chevron-down">
                    <ChevronDownIcon size={12} />
                  </span>
                </button>
              )
            ) : context.repoName === null ? null : repoUrl === null ? (
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
            )}
            {labeled && showSpace && place !== null ? (
              <span class="hwc-pane-head-space" title={placeTitle}>
                {place.parent === null ? null : (
                  <>
                    <span class="hwc-pane-head-place" data-part="parent">
                      {place.parent}
                    </span>
                    <span class="hwc-pane-head-sep" aria-hidden="true">
                      ›
                    </span>
                  </>
                )}
                <span class="hwc-pane-head-place" data-part="space">
                  {place.space}
                </span>
              </span>
            ) : null}
            {labeled || showBranch ? null : <GitCount sync={sync} />}
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
            {/* 開くファイルは会話のペインと同じ配信経路を使う。チャットを持たない
            シェルのペインには出さない（開いても配信できないため）。 */}
            {pane.chat ? (
              <button
                ref={filesButtonRef}
                type="button"
                class="hwc-pane-files"
                aria-label={
                  treeOpen && !treeClosing ? "ファイルツリーを閉じる" : "ファイルツリーを開く"
                }
                aria-pressed={treeOpen && !treeClosing}
                onClick={() => toggleTree(false)}
              >
                <FolderIcon size={16} />
                <span class="hwc-pane-files-label">ファイル</span>
              </button>
            ) : null}
            <span class="hwc-pane-id" data-copied={copied}>
              <span class="hwc-pane-id-text">{pane.id}</span>
              <button
                type="button"
                class="hwc-pane-id-copy"
                aria-label={copied ? "コピーしました" : "ペイン ID をコピー"}
                onClick={copyId}
              >
                <CopyGlyph copied={copied} />
              </button>
            </span>
            {/* ID の外に置く。中に入れると、hover できる端末で ID と一緒に隠れる。 */}
            <button
              type="button"
              class="hwc-pane-more"
              aria-label={`${pane.id} のメニュー`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={MENU_ID}
              onClick={(event) => onOpenMenu(pane.id, event.currentTarget)}
            >
              <MoreIcon />
            </button>
          </div>
        </div>
        {sideBySide && treeSide === "right" ? treeHead : null}
      </div>
      <div
        class="hwc-pane-body"
        ref={widthRef}
        data-tree-split={sideBySide ? "true" : undefined}
        data-tree-side={treeSide}
      >
        {sideBySide && treeSide === "left" ? treeView : null}
        <div class="hwc-chat-column">
          <div class="hwc-output-wrap">
            {sideBySide ? null : treeView}
            <div class="hwc-chat-view" ref={frame}>
              <div
                class="hwc-output-scroll"
                data-empty={empty}
                ref={scroller}
                onScroll={onScroll}
                aria-hidden={chatHidden ? "true" : undefined}
                inert={chatHidden}
              >
                {confirmation !== null ? (
                  <PaneConfirmation
                    key={confirmation.id}
                    confirmation={confirmation}
                    attempt={confirmationAttempts.get(confirmation.id) ?? null}
                    onConfirm={() => onConfirmFolderTrust(confirmation.id)}
                    onDismiss={() => onDismissConfirmation(confirmation.id)}
                  />
                ) : launching || body.kind === "skeleton" ? (
                  <OutputSkeleton />
                ) : body.kind === "chat" ? (
                  <>
                    {body.snapshot.truncated ? (
                      <p class="hwc-output-notice">古い会話は省略されています</p>
                    ) : null}
                    <ChatLog
                      paneId={pane.id}
                      snapshot={body.snapshot}
                      replying={replying}
                      compacting={compacting}
                      copiedId={copiedId}
                      expandable={!compact}
                      compactionEcho={visibleCompactionEcho}
                      compactionDurationMs={
                        compactionDuration !== null &&
                        compactionDuration.at === body.snapshot.compaction?.at
                          ? compactionDuration.ms
                          : null
                      }
                      onCopy={copy}
                      canEdit={(row, rows) =>
                        canEditMessage({
                          row,
                          rows,
                          snapshot: body.snapshot,
                          pane,
                          sending: sending || stopping,
                          editing: edit !== null,
                        })
                      }
                      onEdit={startEdit}
                      onOpenImage={onOpenImage}
                      onOpenPreview={onOpenPreview}
                      pending={pendingMessages}
                      pendingCard={pendingView}
                      onShowTerminal={() => {
                        if (pendingView !== null) setTerminalFor(pendingView.toolUseId);
                      }}
                      onAnswerQuestion={answerQuestionAndRefresh}
                      reveal={reveal}
                    />
                  </>
                ) : (
                  <>
                    {pendingView === null || readOnly ? null : (
                      // 端末出力を見ている間も、応答待ちであることと戻り先を残す。
                      <div class="hwc-pending-bar" role="status">
                        <span>端末で応答してください。</span>
                        <button
                          type="button"
                          class="hwc-pending-toggle"
                          onClick={() => setTerminalFor(null)}
                        >
                          会話に戻る
                        </button>
                      </div>
                    )}
                    {read?.truncated ? (
                      <p class="hwc-output-notice">最新の {OUTPUT_LINES} 行を表示しています</p>
                    ) : null}
                    {failed ? (
                      <p class="hwc-output-notice" role="status">
                        出力を取得できません。接続が戻ると自動で更新します。
                      </p>
                    ) : null}
                    {output === null ? (
                      failed ? null : (
                        <OutputSkeleton />
                      )
                    ) : outputEmpty ? (
                      <OutputEmpty />
                    ) : (
                      <pre class="hwc-output">
                        <OutputText text={output} scheme={scheme} />
                      </pre>
                    )}
                  </>
                )}
              </div>
              {/* 逐次表示の先端を背景へ溶かす。読み返しで上へ離れたら出さない。 */}
              {chatHidden || reveal === null || !atBottom ? null : (
                <div class="hwc-output-fade" aria-hidden="true" />
              )}
              {chatHidden || confirmation !== null ? null : (
                <button
                  type="button"
                  class="hwc-jump"
                  data-visible={!atBottom}
                  aria-label="最新へ"
                  aria-hidden={atBottom}
                  tabIndex={atBottom ? -1 : 0}
                  onClick={jumpToLatest}
                >
                  <ArrowDownIcon />
                </button>
              )}
              {chatHidden ? null : (
                <SelectionToolbar
                  state={selectionToolbar}
                  canQuote={!inputDisabled && !launchBlocked && pane.chat}
                  onQuote={quoteSelection}
                  onCopy={() => {
                    const selection = document.getSelection();
                    const element = scroller.current;
                    if (selection === null || selection.rangeCount === 0 || element === null)
                      return "";
                    return selectionCopyText(element, selection.getRangeAt(0));
                  }}
                  onExited={closeToolbar}
                />
              )}
              {previewOpen && previewPath !== null ? (
                <FilePreview
                  key={previewPath}
                  paneId={pane.id}
                  path={previewPath}
                  workspacePath={props.context.workspacePath}
                  hasNewReply={previewHasNewReply}
                  focusRequest={previewFocus}
                  hidden={treeOverlay && !treeClosing}
                  onOpenImage={onOpenImage}
                  onOpenPreview={onOpenPreview}
                  onClose={closePreview}
                />
              ) : null}
            </div>
          </div>

          {body.kind === "chat" ? (
            <LiveStatus
              open={replying || compacting}
              divider={previewOpen}
              phase={livePhase}
              thought={liveThought}
              elapsedMs={compacting ? compactionElapsedMs : waitingMs}
              compacting={compacting}
              stopping={stopping}
              showThought={showActivityFrame(pane.agent, compact, activity, compacting)}
              tokPerSecond={liveTokPerSecond}
              onCancelCompaction={() => void cancelCompaction()}
            />
          ) : null}

          {notice === null ? null : (
            <p class="hwc-send-notice" role="status">
              <span class="hwc-send-notice-mark">
                <StatusMark tone="attention" size={12} />
              </span>
              {notice}
            </p>
          )}

          {readOnly ? (
            view === "terminal" ? (
              <p class="hwc-terminal-note" role="status">
                この画面は閲覧のみです。操作は Herdr のターミナルで行ってください。
              </p>
            ) : null
          ) : inputDisabled ? (
            // 質問・承認の待ちは TUI のダイアログが入力を受け取る。入力欄ごと閉じる。質問は
            // カードから答えられる。承認と、待ちが読めないときは端末で行う（ADR 0098、0099）。
            <p class="hwc-terminal-note" role="status">
              {pendingView?.kind === "question" && !showTerminal
                ? "Claude の質問です。カードから答えると、入力欄が戻ります。"
                : "Claude の応答待ちです。承認と、カードに出ない質問への回答は Herdr のターミナルで行ってください。"}
            </p>
          ) : (
            <form
              class="hwc-input"
              data-expanded={expanded}
              data-shell={shell}
              data-drop={dropping}
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
              onDragEnter={(event) => {
                const transfer = event.dataTransfer;
                if (launchBlocked || inputDisabled || edit !== null || !pane.chat) return;
                if (transfer === null || dropKind(transfer) === null) return;
                dragDepth.current += 1;
                setDropping(true);
              }}
              onDragOver={(event) => {
                const transfer = event.dataTransfer;
                if (transfer === null || dropKind(transfer) === null) return;
                // 添付を受け付けないペインでもファイルを開かせない。ただし落とせる場所では
                // ないので、copy のカーソルは出さない。
                event.preventDefault();
                transfer.dropEffect =
                  pane.chat && !launchBlocked && !inputDisabled && edit === null ? "copy" : "none";
              }}
              onDragLeave={() => {
                if (dragDepth.current === 0) return;
                dragDepth.current -= 1;
                if (dragDepth.current === 0) setDropping(false);
              }}
              onDrop={(event) => {
                const transfer = event.dataTransfer;
                const kind = dropKind(transfer);
                if (transfer === null || kind === null) return;
                // ファイルはブラウザに開かせない。
                event.preventDefault();
                dragDepth.current = 0;
                setDropping(false);
                if (edit !== null || !pane.chat || launchBlocked || inputDisabled) return;
                if (kind === "files") {
                  takeFiles(dropActionFrom(transfer.files));
                  return;
                }
                // パスは Linux でも 4KB まで。改行や NUL を含む文字列は、送る本文を
                // 崩すので差し込まない。
                const reference = transfer.getData(FILE_REFERENCE_TYPE);
                if (reference === "" || reference.length > 4096) return;
                if (/[\r\n]/.test(reference) || reference.includes("\u0000")) return;
                insertReference(reference);
              }}
            >
              {launchPending ? (
                <LaunchNote
                  launch={launch}
                  onRetry={props.onRetryLaunch}
                  onUseShell={props.onUseShell}
                />
              ) : null}
              <label class="hwc-visually-hidden" for={`hwc-input-${pane.id}`}>
                {context.workspaceLabel} / {context.tabLabel} のペインへ送る
              </label>
              <div class="hwc-input-frame">
                {compact ? null : (
                  <button
                    type="button"
                    class="hwc-input-toggle"
                    aria-expanded={expanded}
                    aria-controls={`hwc-input-${pane.id}`}
                    aria-label={expanded ? "入力を折りたたむ" : "入力を広げる"}
                    onClick={toggleExpanded}
                  >
                    {expanded ? <CollapseIcon /> : <ExpandIcon />}
                  </button>
                )}
                {edit !== null ? (
                  <div class="hwc-commands" role="group" aria-label="編集中">
                    <span class="hwc-command" data-chip="true" data-edit="true">
                      <PencilIcon size={14} />
                      <span class="hwc-command-label">編集中</span>
                      {editTarget === null ? null : (
                        <span class="hwc-command-text">{formatClock(editTarget.at)}</span>
                      )}
                      <button
                        type="button"
                        class="hwc-command-clear"
                        aria-label="編集をやめる"
                        disabled={edit.sending}
                        onClick={cancelEdit}
                      >
                        <CloseIcon size={14} />
                      </button>
                    </span>
                  </div>
                ) : attachments.length > 0 ? (
                  <div class="hwc-commands" role="group" aria-label="添付ファイル">
                    {attachments.map((item) => {
                      const name = item.name;
                      return (
                        <span class="hwc-command hwc-attachment" data-chip="true" key={item.key}>
                          {name === null ? (
                            <span class="hwc-attachment-sending">送信中</span>
                          ) : attachmentExtFromName(name) === null ? (
                            // 画像以外は配信しない。名前だけを見せ、押しても何も開かない。
                            <>
                              <span class="hwc-attachment-name" title={name}>
                                {name}
                              </span>
                              <span class="hwc-attachment-size">{formatFileSize(item.size)}</span>
                            </>
                          ) : (
                            <button
                              type="button"
                              class="hwc-attachment-open"
                              aria-label="添付画像を拡大"
                              aria-haspopup="dialog"
                              onClick={() => onOpenImage(attachmentUrl(pane.id, name), name)}
                            >
                              <img
                                class="hwc-attachment-thumb"
                                src={attachmentUrl(pane.id, name)}
                                alt=""
                              />
                            </button>
                          )}
                          <button
                            type="button"
                            class="hwc-command-clear"
                            aria-label="添付を外す"
                            onClick={() => removeAttachment(item.key)}
                          >
                            <CloseIcon size={14} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                ) : activeChip !== null ? (
                  <div class="hwc-commands">
                    <span class="hwc-command" data-chip="true">
                      <CommandBadge id={activeChip} />
                      <button
                        type="button"
                        class="hwc-command-clear"
                        aria-label={`${commandText(activeChip)} を解除`}
                        onClick={clearChip}
                      >
                        <CloseIcon size={14} />
                      </button>
                    </span>
                  </div>
                ) : candidates.length === 0 ? null : (
                  <div class="hwc-commands" role="group" aria-label="コマンド候補">
                    {candidates.map((id) => (
                      <button type="button" class="hwc-command" key={id} onClick={() => pick(id)}>
                        <CommandBadge id={id} />
                      </button>
                    ))}
                  </div>
                )}
                <span class="hwc-input-line">
                  {/* 消えるときに幅が跳ねないよう、シェル以外でも置いたまま折りたたむ。 */}
                  <span
                    class="hwc-input-prompt"
                    aria-hidden="true"
                    data-hidden={shell ? undefined : "true"}
                  >
                    $
                  </span>
                  <textarea
                    id={`hwc-input-${pane.id}`}
                    ref={input}
                    class="hwc-input-field"
                    // 2 行ぶんの高さを初期値にすると、1 行のとき文字の下だけ空いて上に寄る。
                    // 高さは fit() が入力量に合わせて伸ばす。
                    rows={1}
                    disabled={edit?.sending === true}
                    value={inputText}
                    // ツリーの行を掴むと入力欄からフォーカスが外れる。落としたときに使う
                    // 選択位置をここで控える。まだ一度もフォーカスしていなければ末尾へ入れる。
                    onBlur={(event) => {
                      const field = event.currentTarget;
                      lastSelection.current = {
                        start: field.selectionStart,
                        end: field.selectionEnd,
                      };
                    }}
                    // 簡略時は placeholder を付けない。狭い入力欄で「メッセージを入力」が切れる。
                    {...(compact ? {} : { placeholder })}
                    onInput={(event) => {
                      setInputText(event.currentTarget.value);
                    }}
                    onPaste={(event) => {
                      // シェルは改行を受け取れない。末尾の改行だけなら落として差し込み、
                      // 途中に改行が残るなら入力を変えずに断る。
                      if (shell) {
                        const raw = event.clipboardData?.getData("text/plain") ?? "";
                        if (!/[\r\n]/.test(raw)) return;
                        const text = raw.replace(/[\r\n]+$/, "");
                        event.preventDefault();
                        if (/[\r\n]/.test(text)) {
                          setNotice(SHELL_NEWLINE_NOTICE);
                          return;
                        }
                        const field = event.currentTarget;
                        field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
                        setDraft(field.value);
                        fit(field, expanded);
                        return;
                      }
                      // 添付を受け付けるのは会話を持つペインだけ。起動中はテキストだけ。
                      if (edit !== null || !pane.chat || launchBlocked || inputDisabled) return;
                      const action = pasteActionFrom(event.clipboardData?.items);
                      // テキストだけの貼り付けは入力欄の既定動作のままにする。
                      if (action.kind === "default") return;
                      if (takeFiles(action)) event.preventDefault();
                    }}
                    onKeyDown={(event) => {
                      const composing = event.isComposing || event.keyCode === 229;
                      if (event.key !== "Enter") return;
                      if (composing) return;
                      // シェルは改行を受け取れない。タッチ端末でも Enter で送る。
                      const newline =
                        event.shiftKey ||
                        (!shell &&
                          enterInsertsNewline((query) => window.matchMedia(query).matches));
                      if (newline) {
                        if (shell) event.preventDefault();
                        return;
                      }
                      event.preventDefault();
                      submit();
                    }}
                  />
                </span>
                <div class="hwc-input-actions">
                  {/* 入口を出すのはシェルだけ。会話を読めないエージェント（supportsChat が false の
                未知のエージェント）は chat が false になるので、chat ではなくペインの種類で分ける。 */}
                  {compact ? null : shell ? (
                    <button type="button" class="hwc-agent-start" onClick={startAgent}>
                      <AgentIcon size={16} />
                      エージェントを起動
                    </button>
                  ) : pane.chat && !launchBlocked && !inputDisabled && edit === null ? (
                    <ComposerAdd
                      full={attachments.length >= MAX_ATTACHMENTS}
                      commands={composerCommands}
                      templateCount={templates === null ? null : templates.length}
                      templateBlock={templateBlock}
                      onFiles={(files) => takeFiles(dropActionFrom(files))}
                      onProjects={openProjects}
                      onTemplates={openTemplates}
                    />
                  ) : null}
                  <span class="hwc-input-tail">
                    {info === null && !infoLoading && meter === null ? null : (
                      <span class="hwc-input-info">
                        <span class="hwc-input-agent" data-agent={agentGlyph(pane.agent)}>
                          <AgentGlyphIcon agent={pane.agent} size={14} />
                        </span>
                        {infoLoading ? (
                          <AgentInfoSkeleton />
                        ) : info === null ? null : (
                          <AgentInfoHint info={info} />
                        )}
                        {meter === null || snapshot?.context == null ? null : (
                          <ContextMeter
                            key={pane.id}
                            view={meter}
                            context={snapshot.context}
                            usage={snapshot.usage}
                          />
                        )}
                      </span>
                    )}
                    <button
                      type={stop && !busy ? "button" : "submit"}
                      class="hwc-send"
                      data-sending={sendingAny}
                      data-stopping={stopping}
                      data-launching={launching}
                      aria-label={
                        launching
                          ? "起動中"
                          : stopping
                            ? "停止中"
                            : sendingAny
                              ? "送信中"
                              : stop
                                ? "停止"
                                : edit !== null
                                  ? "編集を送信"
                                  : "送信"
                      }
                      aria-busy={launching || undefined}
                      disabled={busy || launchBlocked || (!stop && !sendable)}
                      onClick={stop && !busy ? stopWorking : undefined}
                    >
                      {busy || launching ? <Spinner /> : stop ? <StopIcon /> : <SendIcon />}
                    </button>
                  </span>
                </div>
              </div>
            </form>
          )}
        </div>
        {sideBySide && treeSide === "right" ? treeView : null}
      </div>
      {projectDialog === null ? null : (
        <ProjectDialog
          paneId={pane.id}
          open={projectDialog.open}
          onClose={closeProjects}
          onExited={projectsExited}
          onPick={pickProject}
        />
      )}
      {templateDialog === null ? null : (
        <TemplateDialog
          open={templateDialog.open}
          onClose={closeTemplates}
          onExited={templatesExited}
          onPick={pickTemplate}
        />
      )}
      {confirmNew
        ? createPortal(
            <NewSessionConfirm
              paneId={pane.id}
              available={menuCommandAvailable("new")}
              onConfirm={() => {
                setConfirmNew(false);
                void runMenuCommand("new");
              }}
              onCancel={() => setConfirmNew(false)}
            />,
            document.querySelector(".hwc-app") ?? document.body,
          )
        : null}
    </>
  );
}
