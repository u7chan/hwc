import { createPortal, type Ref } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatAttachment, ChatFile, ChatPending } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import type { QuestionAnswer } from "../shared/answer";
import type { FileTreeEntry } from "../shared/file-tree";
import type { GitSync } from "../shared/git";
import { attachmentKindOfFileName } from "../shared/attachments";
import { activityLabel, activitySnippet, showActivityFrame, usePaneActivity } from "./activity";
import { OUTPUT_LINES, answerQuestion, editMessage, uploadAttachment } from "./api";
import { attachmentStore } from "./attachment-store";
import { FILE_REFERENCE_TYPE, fileReference } from "./file-reference";
import { fileTreeStore } from "./file-tree-store";
import type { FileTreeSide } from "./file-tree-side";
import { OutputText } from "./OutputText";
import {
  SEND_FAILED_NOTICE,
  SHELL_BUSY_NOTICE,
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
import { composerDisabled } from "./input";
import { useMessageReveal } from "./reveal";
import {
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
import { useCopy } from "./copy";
import { filterProjects, highlightedProject } from "./projects";
import { ModelSwitchDialog } from "./ModelSwitchDialog";
import { modelSwitchBlockReason } from "./model-switch";
import { NewSessionConfirm } from "./NewSessionConfirm";
import { ProjectDialog } from "./ProjectDialog";
import { useProjects } from "./use-projects";
import { ArrowDownIcon, ChevronLeftIcon, StatusMark } from "./icons";
import { useElementWidth } from "./app/use-element-width";
import { usePaneOutput } from "./output";
import { ChatLog } from "./pane/chat-log";
import { OutputEmpty, OutputSkeleton } from "./pane/empty";
import { FilePreview } from "./pane/file-preview";
import { FileTree } from "./pane/file-tree";
import { LiveStatus } from "./pane/live-status";
import { PaneComposer } from "./pane/pane-composer";
import { PaneHead } from "./pane/pane-head";
import { useAttachments } from "./pane/use-attachments";
import { useComposer } from "./pane/use-composer";
import { useFilePreview } from "./pane/use-file-tree";
import { useFileTreePanel } from "./pane/use-file-tree-panel";
import { useTemplates } from "./pane/use-templates";
import { useCompactionEcho } from "./pane/use-compaction-echo";
import { useDefaultModel } from "./pane/use-default-model";
import { useLaunchModel } from "./pane/use-launch-model";
import { canEditMessage, editFailureNotice } from "./edit";
import { useOutputFollow } from "./pane/use-output-follow";
import { useOutputVersion } from "./pane/use-output-version";
import { usePreviewReplyBadge } from "./pane/use-preview-reply";
import { useSelectionToolbar } from "./pane/use-selection-toolbar";
import { usePullRequest } from "./pull-request";
import { confirmationView, type ConfirmationAttempt } from "./confirmation";
import { PaneConfirmation } from "./PaneConfirmation";
import { canSend, canStop } from "./reply";
import { isShellPane, type PaneContext } from "./select";
import { SelectionToolbar } from "./SelectionToolbar";
import { TemplateDialog } from "./TemplateDialog";
import { selectionCopyText } from "./selection-copy";
import { type PaneLaunchView } from "./starting";

const PENDING_TIMEOUT_MS = 60_000;
const NEW_SESSION_TIMEOUT_MS = 60_000;

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
  // 複数スペースのペインが並ぶときだけ、見出しに場所を添える。
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
  // ツリーのフォルダを作業ディレクトリにしたスペースを作る。path はツリーの根からの相対パス。
  onCreateSpace: (path: string) => void;
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
  // ツリーを横に並べるかは、ウィンドウではなく実際のセル幅で決める。狭いセルでは
  // 会話の上に重ねる。
  const { ref: widthRef, width: frameWidth } = useElementWidth<HTMLDivElement>();
  const {
    view: fileTree,
    buttonRef: filesButtonRef,
    open: treeOpen,
    sideBySide,
    overlay: treeOverlay,
    shown: treeShown,
    closing: treeClosing,
    focusRequest: treeFocus,
    close: closeTree,
    toggle: toggleTree,
  } = useFileTreePanel({ paneId: pane.id, current, frameWidth });
  const previewPath = useFilePreview(pane.id);
  // ライブ更新でスペースの根が変わると、取得済みの相対パスと選択中のファイルの意味が
  // 変わる。次の取得から新しい根で解決するよう、store の根を合わせる。
  useEffect(() => {
    fileTreeStore.syncRoot(pane.id, props.context.workspacePath);
  }, [pane.id, props.context.workspacePath]);
  // 狭いセルで選択したときだけ、プレビューへフォーカスを移す。
  const [previewFocus, setPreviewFocus] = useState<{ focus: boolean }>({ focus: false });
  const previewOpen = previewPath !== null;
  // 会話は DOM に残してスクロール位置を保ち、表示だけを差し替える。
  const chatHidden = treeOverlay || previewOpen;
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const { outputVersion, requestOutputRefresh } = useOutputVersion();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [sessionReset, setSessionReset] = useState<NewSessionReset | null>(null);
  // 入力欄の状態と遷移は useComposer が持つ。ここは添付と定型文の取得だけを残す。
  const attachments = useAttachments(pane.id);
  // + メニューの「定型文を引用」を押せるかだけに使う。読めなければ押せる側に倒す。
  const templates = useTemplates(pane.chat);

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
  // 実行中の段階は pi 拡張の sidecar、Claude は transcript の進行行から取る（docs/adr/pi-integration.md / docs/adr/claude-integration.md）。
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
  // 開いている間だけ既定を読み、スケルトンで待ちを示す。
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
  // 会話を読めないペインは、hwc が預かっている起動時の指定でモデルを補う（docs/adr/agent-launch.md）。
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

  // 作ったペインは、閉じたダイアログの続きでそのまま打ち始められるように焦点を移す。
  // iOS は非同期の後にキーボードを出さないことがあるので、焦点だけを合わせる。
  useEffect(() => {
    if (launch === null || launch.phase !== "launching") return;
    input.current?.focus();
  }, [launch === null ? null : launch.phase]);

  const { copiedId, copy } = useCopy();
  const copied = copiedId === "pane";
  const copyId = () => copy("pane", pane.id);

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

  // 添付の保存。ペインを切り替えても止めない。送り先が消えたときだけ App が中断する。
  // 失敗したときだけ、入力欄の上に出す文言を返す（表示は composer が持つ）。
  const uploadFile = async (file: File): Promise<string | null> => {
    const { key, controller } = attachmentStore.begin(pane.id, file.size);

    const result = await uploadAttachment(pane.id, file, controller.signal);
    if (result.ok) {
      attachmentStore.settle(pane.id, key, result.name);
      return null;
    }
    // 外された添付は一覧から既に消えている。その失敗は知らせない。
    if (controller.signal.aborted) return null;
    attachmentStore.remove(pane.id, key);
    return uploadFailureNotice(result.status, attachmentKindOfFileName(file.name));
  };

  // 入力欄まわりの state は useComposer が持つ。添付と定型文の取得、送信と編集の API 呼び出しは
  // ここに残す。
  const composer = useComposer({
    pane,
    shell,
    inputDisabled,
    launchBlocked,
    sending,
    attachments,
    selection: { toolbar: selectionToolbar, dismiss: dismissSelection },
    input: { field: input, pendingCaret, fit, expanded },
    upload: uploadFile,
  });
  const editTarget =
    snapshot?.messages.find((message) => message.id === composer.edit?.messageId) ?? null;
  const compactDone = snapshot !== null && compactAlreadyDone(snapshot);
  // 添付を持っている間は候補を出さない。候補を選ぶと本文が消えるので、貼った画像と
  // 書きかけの指示が別々のメッセージに分かれてしまう。引用は下書きの一部なので、
  // 本文の先頭が `/` でなければ候補は出ない。空の会話と圧縮済みは commandAvailable が見る。
  // 起動中も出すと、選んだ時点で下書きがチップに変わり消える。準備ができるまで出さない。
  const candidates =
    composer.edit === null &&
    !launchBlocked &&
    !inputDisabled &&
    attachments.length === 0 &&
    compactionRun === null
      ? commandCandidates(pane, composer.draft, snapshot)
      : [];
  // + メニューは分割セルでは出ないので、同じ条件にせず `@` で選べるようにする。
  // `@` の候補を出すかの判断は composer が持つ。取り直すのは候補を出す間だけ。
  const projects = useProjects(pane.id, composer.mention !== null);
  const suggestions =
    composer.mention !== null && !composer.mentionClosed && projects.load.kind === "ready"
      ? filterProjects(projects.load.projects, composer.mention.query)
      : [];
  const suggested = highlightedProject(suggestions, composer.mentionHighlight);
  const uploading = attachments.some((item) => item.name === null);
  const editSendable =
    composer.edit !== null &&
    composer.edit.text.trim() !== "" &&
    pane.agentStatus !== "working" &&
    !composer.edit.sending;
  const sendable =
    composer.edit !== null
      ? editSendable
      : canSend({
          uploading,
          chip: composer.activeChip,
          replying,
          draft: composer.draft,
          attachments: attachments.length,
        });
  const sendingAny = sending || composer.edit?.sending === true;
  // 停止は入力が空のときだけ出す。文字・添付・引用があれば、送信は実行中への追加指示になる。
  const stop =
    composer.edit === null &&
    canStop({
      replying,
      agent: pane.agent,
      running,
      draft: composer.draft,
      attachments: attachments.length,
      chip: composer.activeChip,
    });
  const busy = sendingAny || stopping;
  const placeholder =
    composer.edit !== null
      ? "この発言を編集"
      : composer.activeChip === "compact"
        ? "圧縮の指示（任意）"
        : shell
          ? "コマンドを入力"
          : "メッセージを入力";
  // 圧縮のチップ中は入力欄が指示になる。長い定型文を引用する先ではない。
  const templateBlock =
    composer.edit === null && composer.activeChip === "compact" ? "圧縮の指示には使えません" : null;
  // 起動の行は、待ちと失敗の間だけ出す。準備ができたら入力欄だけを残す。
  const launchNote = launchPending ? launch : null;

  // 前景でコマンドが動いていると Herdr は起動を受け付けない。先に止めてもらう。
  const startAgent = () => {
    if (running) {
      composer.setNotice(SHELL_BUSY_NOTICE);
      return;
    }
    props.onStartAgent();
  };

  // 送信で空にしたときも、高さを初期状態へ戻す。分割枚数が変わって簡略が切り替わったときも、
  // 前の inline height を残さない。
  // 描画の後に高さを直すと、改行した 1 フレームだけ箱が低いままになり、
  // スクロールバーが一瞬出る。描画の前に合わせる。
  useLayoutEffect(() => {
    fit(input.current, expanded);
  }, [composer.inputText, expanded, compact, inputDisabled]);

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
  }, [composer.draft, expanded]);

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
    notice: composer.notice,
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

  // 外した添付は送らない。進行中のアップロードも止める。保存先のファイルは消さない。
  const removeAttachment = (key: string) => attachmentStore.remove(pane.id, key);

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

  const sendEdit = async () => {
    if (composer.edit === null || composer.edit.sending || inputDisabled || launchBlocked) return;
    if (composer.edit.text.trim() === "") return;
    if (pane.agentStatus === "working") {
      composer.setNotice("実行中は編集できません");
      return;
    }
    const pendingEdit = { ...composer.edit, sending: true };
    composer.beginSend();
    composer.setEdit(pendingEdit);
    const result = await editMessage(
      pane.id,
      pendingEdit.messageId,
      pendingEdit.requestId,
      pendingEdit.text,
    );
    if (result.ok) {
      composer.setEdit(null);
      setPinned(true);
      refreshChat();
      return;
    }
    composer.setEditSending(false);
    composer.setNotice(editFailureNotice(result.error, result.rewound));
    if (result.rewound) refreshChat();
  };

  const sendText = async () => {
    if (composer.edit !== null) {
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
    const text = composer.draft;
    // 添付があると BFF が注記を後ろに付けるので、pi では /compact でもコマンドにならない。
    const compactCommand = attachments.length === 0 && isCompactCommand(text);
    const newCommand = startsNewSession(text, names);
    if (compactCommand && compactDone) {
      composer.setNotice(COMPACTED_NOTICE);
      return;
    }
    const baselineAt = snapshot?.compaction?.at ?? null;
    const from = latestUserAt(snapshot?.messages ?? []);
    const waiting = replying;
    const after = snapshot?.messages.length ?? 0;
    composer.beginSend();
    // 送れたときだけ空にする。失敗したら本文も添付も残す。
    if (await submitInput(text, names)) {
      // 猶予は送信が通った時点から測る。POST が遅いときに、届く前の echo を畳まない。
      const at = Date.now();
      // 送れたときだけ最新へ戻す。失敗したら読み返していた位置を保つ。
      setPinned(true);
      composer.clearDraft();
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
      composer.setNotice(SEND_FAILED_NOTICE);
    }
  };

  const stopWorking = async () => {
    if (stopping || !stop) return;
    setStopping(true);
    composer.setNotice(null);
    if (!(await onStop())) composer.setNotice(STOP_FAILED_NOTICE);
    setStopping(false);
  };

  // 手動 compaction は Herdr の working にならないため、失敗しても agent_status から
  // 判別できない。10 分の上限だけに頼らず、進捗行から Esc を送ってローカルの開始記録を
  // 畳めるようにする。
  const cancelCompaction = async () => {
    if (stopping) return;
    setStopping(true);
    composer.setNotice(null);
    if (await onStop()) {
      clearCompaction();
    } else composer.setNotice(STOP_FAILED_NOTICE);
    setStopping(false);
  };

  // /new は user 発話を残さないので、送信中バブルを積むと最大 60 秒残る。
  // compact は draft を指示として後ろに付ける。送れたときだけ両方空にする。
  const sendCommand = async (id: CommandId) => {
    if (composer.edit !== null) return;
    if (inputDisabled || launchBlocked || sending || replying || compactionRun !== null) return;
    if (id === "compact" && compactDone) {
      composer.setNotice(COMPACTED_NOTICE);
      return;
    }
    const text = commandSendText(id, composer.draft);
    const baselineAt = snapshot?.compaction?.at ?? null;
    composer.beginSend();
    if (await submitInput(text, [])) {
      setPinned(true);
      composer.setChip(null);
      composer.setDraft("");
      if (id === "compact") markCompaction(baselineAt, text);
    } else composer.setNotice(SEND_FAILED_NOTICE);
  };

  // メニューからはコマンド文字列だけを送る。書きかけの draft・添付は次の
  // メッセージのために残す（チップのように draft を指示には使わない）。
  const menuCommandAvailable = (id: CommandId): boolean =>
    composer.edit === null &&
    !inputDisabled &&
    !launchBlocked &&
    !sending &&
    compactionRun === null &&
    commandAvailable(id, pane, snapshot);

  const runMenuCommand = async (id: CommandId) => {
    if (composer.edit !== null || !menuCommandAvailable(id)) return;
    const text = commandText(id);
    const baselineAt = snapshot?.compaction?.at ?? null;
    composer.beginSend();
    if (await submitInput(text, [])) {
      setPinned(true);
      composer.setChip(null);
      if (id === "compact") markCompaction(baselineAt, text);
    } else composer.setNotice(SEND_FAILED_NOTICE);
  };

  const menuCommandHint = (id: CommandId): string => {
    if (sending) return "送信中は使えません";
    if (compactionRun !== null) return "圧縮中は使えません";
    if (pane.agentStatus === "working") return "実行中は使えません";
    const reason = commandBlockReasonFor(id, snapshot);
    if (reason !== null) return COMMAND_BLOCK_NOTES[reason];
    return id === "new" ? "このペインで会話を始め直す" : "履歴を要約して縮める";
  };

  // モデルと effort の切り替えは、メニューの項目から開くダイアログで行う。コマンド文字列を
  // 入力欄から送る /new・/compact とは違い、選んだ内容を BFF へ渡す。
  const modelSwitchReason =
    pane.agent === "claude" &&
    (composer.edit !== null ||
      inputDisabled ||
      launchBlocked ||
      sending ||
      replying ||
      compactionRun !== null)
      ? "操作中は使えません"
      : modelSwitchBlockReason(pane);
  const modelSwitch =
    pane.agent === "claude"
      ? {
          label: "モデルとエフォートを変更",
          available: modelSwitchReason === null,
          hint: modelSwitchReason ?? "会話を保ったまま、次の応答から切り替える",
          run: () => {
            if (modelSwitchReason === null) setSwitchOpen(true);
          },
        }
      : null;

  const composerCommands = isCommandPane(pane)
    ? {
        newSession: {
          label: commandLabel("new"),
          available: menuCommandAvailable("new"),
          hint: menuCommandHint("new"),
          run: () => {
            if (menuCommandAvailable("new")) composer.setConfirmNew(true);
          },
        },
        compact: {
          label: commandLabel("compact"),
          available: menuCommandAvailable("compact"),
          hint: menuCommandHint("compact"),
          run: () => void runMenuCommand("compact"),
        },
        modelSwitch,
      }
    : null;

  const submit = () => {
    if (inputDisabled || launchBlocked) return;
    if (composer.edit !== null) {
      void sendEdit();
      return;
    }
    // 添付中は候補にもチップにも流さない。
    if (attachments.length === 0) {
      if (composer.activeChip !== null) {
        void sendCommand(composer.activeChip);
        return;
      }
      const first = candidates[0];
      if (first !== undefined) {
        composer.pick(first);
        return;
      }
    }
    void sendText();
  };

  // 圧縮中は hwc のローカル表示が正。拡張の段階と重ねない。
  const livePhase = compacting || activity === null ? null : activityLabel(activity);
  // 会話に載った本文も帯から外さない。外すと、本文が会話へ届いた瞬間に帯が空になり、
  // 読み切る前に消える。次の本文が来るかターンが終わるまで残す。
  const liveThought = compacting || activity === null ? "" : activitySnippet(activity.text);
  // 低いセルは段階と経過時間だけにし、会話へ高さを回す。速度は通常セルでだけ出す。
  const liveTokPerSecond =
    compacting || compact || activity === null ? null : activity.tokPerSecond;

  const closePreview = () => {
    fileTreeStore.clearPreview(pane.id);
    // 閉じた後にフォーカスが body へ落ちないよう、ツリーの入口へ戻す。
    filesButtonRef.current?.focus();
  };

  // 行のドラッグは、プレビューの「パスをコピー」と同じ文字列を運ぶ。ツリーの根は
  // スペースのチェックアウトで、ペインの cwd とは限らない。
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
      onCreateSpace={props.onCreateSpace}
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
      <PaneHead
        pane={pane}
        context={context}
        labeled={labeled}
        showSpace={showSpace}
        showBranch={showBranch}
        branch={branch}
        sync={sync}
        pullRequest={pullRequest}
        files={{
          open: treeOpen && !treeClosing,
          buttonRef: filesButtonRef,
          onToggle: () => toggleTree(false),
        }}
        copy={{ copied, onCopy: copyId }}
        spaceMenu={{
          open: workspaceMenuOpen,
          onOpen: (trigger) => onOpenWorkspaceMenu(context.workspaceId, trigger),
        }}
        paneMenu={{ open: menuOpen, onOpen: (trigger) => onOpenMenu(pane.id, trigger) }}
        leading={sideBySide && treeSide === "left" ? treeHead : null}
        trailing={sideBySide && treeSide === "right" ? treeHead : null}
      />
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
                      canEdit={(row) =>
                        canEditMessage({
                          row,
                          snapshot: body.snapshot,
                          pane,
                          sending: sending || stopping,
                          editing: composer.edit !== null,
                        })
                      }
                      onEdit={composer.beginEdit}
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
                          class="hwc-pending-toggle hwc-pending-toggle-back"
                          onClick={() => setTerminalFor(null)}
                        >
                          <ChevronLeftIcon size={16} />
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
                  onQuote={composer.quoteSelection}
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
                  backLabel={body.kind === "chat" ? "会話に戻る" : "出力に戻る"}
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

          {composer.notice === null ? null : (
            <p class="hwc-send-notice" role="status">
              <span class="hwc-send-notice-mark">
                <StatusMark tone="attention" size={12} />
              </span>
              {composer.notice}
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
            // カードから答えられる。承認と、待ちが読めないときは端末で行う（docs/adr/claude-integration.md）。
            <p class="hwc-terminal-note" role="status">
              {pendingView?.kind === "question" && !showTerminal
                ? "Claude の質問です。カードから答えると、入力欄が戻ります。"
                : "Claude の応答待ちです。承認と、カードに出ない質問への回答は Herdr のターミナルで行ってください。"}
            </p>
          ) : (
            <PaneComposer
              composer={composer}
              target={{ pane, context }}
              view={{
                compact,
                expanded,
                shell,
                inputDisabled,
                launchBlocked,
                launchNote,
                launching,
                editTarget,
                candidates,
                commands: composerCommands,
                mentions: { query: composer.mention?.query ?? null, suggestions, suggested },
                attachments,
                templateCount: templates === null ? null : templates.length,
                templateBlock,
                info,
                infoLoading,
                meter,
                context: snapshot?.context ?? null,
                usage: snapshot?.usage,
                sendable,
                stop,
                busy,
                sendingAny,
                stopping,
                placeholder,
              }}
              actions={{
                submit,
                stopWorking,
                startAgent,
                toggleExpanded,
                retryLaunch: props.onRetryLaunch,
                useShell: props.onUseShell,
                openImage: props.onOpenImage,
                removeAttachment,
              }}
            />
          )}
        </div>
        {sideBySide && treeSide === "right" ? treeView : null}
      </div>
      {composer.projectDialog === null ? null : (
        <ProjectDialog
          paneId={pane.id}
          open={composer.projectDialog.open}
          onClose={composer.closeProjects}
          onExited={composer.projectsExited}
          onPick={composer.pickProject}
        />
      )}
      {composer.templateDialog === null ? null : (
        <TemplateDialog
          open={composer.templateDialog.open}
          onClose={composer.closeTemplates}
          onExited={composer.templatesExited}
          onPick={composer.pickTemplate}
        />
      )}
      {switchOpen
        ? createPortal(
            <ModelSwitchDialog
              paneId={pane.id}
              current={info}
              onSwitched={refreshChat}
              onClose={() => setSwitchOpen(false)}
            />,
            document.querySelector(".hwc-app") ?? document.body,
          )
        : null}
      {composer.confirmNew
        ? createPortal(
            <NewSessionConfirm
              paneId={pane.id}
              available={menuCommandAvailable("new")}
              onConfirm={() => {
                composer.setConfirmNew(false);
                void runMenuCommand("new");
              }}
              onCancel={() => composer.setConfirmNew(false)}
            />,
            document.querySelector(".hwc-app") ?? document.body,
          )
        : null}
    </>
  );
}
