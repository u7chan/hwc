import { createPortal, type Ref } from "preact";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatFile } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import { gitStatusLabel, type GitSync } from "../shared/git";
import { MAX_ATTACHMENTS } from "../shared/attachments";
import { activityLabel, activitySnippet, usePaneActivity } from "./activity";
import { OUTPUT_LINES, attachmentUrl, uploadAttachment } from "./api";
import { attachmentStore } from "./attachment-store";
import { OutputText } from "./OutputText";
import { isLayoutShift, isNearBottom, isUserScrollDuringGrowth } from "./scroll";
import {
  ATTACHMENT_LIMIT_NOTICE,
  type AttachmentAction,
  dropActionFrom,
  pasteActionFrom,
  SEND_FAILED_NOTICE,
  SHELL_BUSY_NOTICE,
  SHELL_NEWLINE_NOTICE,
  STOP_FAILED_NOTICE,
  unsupportedImageNotice,
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
  usePaneChat,
} from "./chat";
import { enterInsertsNewline } from "./input";
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
import { readDraft, storage, writeDraft } from "./drafts";
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
  MoreIcon,
  PaneIcon,
  SendIcon,
  StatusMark,
  StopIcon,
} from "./icons";
import { GitCount } from "./GitCount";
import { MENU_ID } from "./Menu";
import { usePaneOutput } from "./output";
import { ChatLog } from "./pane/chat-log";
import { OutputEmpty, OutputSkeleton } from "./pane/empty";
import { AgentInfoHint, CommandBadge, ContextMeter } from "./pane/info";
import { LiveStatus } from "./pane/live-status";
import { useAttachments } from "./pane/use-attachments";
import { usePullRequest } from "./pull-request";
import { confirmationView, type ConfirmationAttempt } from "./confirmation";
import { PaneConfirmation } from "./PaneConfirmation";
import { appendQuote, canSend, canStop } from "./reply";
import {
  agentGlyph,
  isShellPane,
  paneName,
  pullRequestLabel,
  shortenPaneName,
  type PaneContext,
} from "./select";
import { SelectionToolbar, type SelectionToolbarState } from "./SelectionToolbar";
import { readSelectionAnchor } from "./selection-toolbar";
import { selectionCopyText } from "./selection-copy";
import { Spinner } from "./Spinner";

const PENDING_TIMEOUT_MS = 60_000;
const NEW_SESSION_TIMEOUT_MS = 60_000;

// スマホは選択メニューを差し替えられない。選択ツールバーはポインタを持つ画面だけに出す。
// 端末の性質は途中で変わらないので、最初の判定を使い回す。
let touchOnly: boolean | null = null;
function touchFirst(): boolean {
  touchOnly ??=
    window.matchMedia("(hover: none)").matches || window.matchMedia("(pointer: coarse)").matches;
  return touchOnly;
}

type PaneDetailProps = {
  pane: PaneState;
  context: PaneContext;
  compact: boolean;
  // 端末出力の ANSI 色を補正する基準。テーマの解決結果を App から受け取る。
  scheme: "light" | "dark";
  // 分割セルが並ぶときだけ、セルの名前を出す。チップと同じ文字列の繰り返しを避ける。
  labeled: boolean;
  // 複数スペースのペインが並ぶときだけ、見出しにスペース名を添える（ADR 0019）。
  showSpace: boolean;
  // スペースのブランチ。分割セルでも PR のチップを引くために渡す。
  // 文字として出すかは showBranch が決め、labeled のときは名前を優先する。
  branch: string | null;
  // 一覧が隠れる狭い画面でだけ、ブランチを名前に代えて出す。
  showBranch: boolean;
  // 1 枚表示のときだけ渡す。分割セルは同じ上流の差が並ぶので出さない。
  sync: GitSync | null;
  workspaceMenuOpen: boolean;
  waitingMs: number | null;
  // シェルの前景プロセスが動いているか。停止ボタンの出し分けにだけ使う。
  running: boolean;
  sending: boolean;
  // 作ったばかりで、まだエージェントが端末を引き継いでいない。入力欄を閉じる。
  starting: boolean;
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
    labeled,
    showSpace,
    branch,
    showBranch,
    sync,
    workspaceMenuOpen,
    waitingMs,
    running,
    sending,
    starting,
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
  const shownPaneName = shortenPaneName(
    paneName(pane),
    context.workspaceLabel,
    context.workspaceName,
  );
  // 下書きはペインごとに残す。書きかけのまま一覧へ戻っても消えない。
  const [draft, setDraft] = useState(() => readDraft(storage(), pane.id));
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // クリア後にポーリングを待たず、出力を取り直すための契機。
  const [outputVersion, setOutputVersion] = useState(0);
  // 追従するかは state が正。イベント購読からも読むので、同じ値を ref に写す
  // （chat.ts の statusRef と同じ扱い）。更新は setPinned の 1 経路だけ。
  const pinned = useRef(true);
  // 高さが変わっただけのスクロール（入力欄や添付が伸縮して底が詰まる）は利用者の操作ではない。
  // 直前の content 高・表示領域の高さと比べて、変わっていれば追従の判断を変えない。
  const lastHeight = useRef(0);
  const lastClientHeight = useRef(0);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [sessionReset, setSessionReset] = useState<NewSessionReset | null>(null);
  // チップは id だけを持つ。表示名と送信文字列は定数から引く。
  const [chip, setChip] = useState<CommandId | null>(null);
  // メニューからの /new だけ、送る前に確認する。
  const [confirmNew, setConfirmNew] = useState(false);
  const attachments = useAttachments(pane.id);
  // プロジェクトのダイアログは閉じるアニメーションの間も残す。caret は選んだ直後に
  // 入力欄へ戻す位置で、閉じただけ（キャンセル）のときは null のまま。
  const [projectDialog, setProjectDialog] = useState<{
    open: boolean;
    caret: number | null;
  } | null>(null);
  // ファイルをドラッグしている間だけ composer を光らせる。dragenter / dragleave は
  // 子要素をまたぐたびに入れ替わるので、深さを数えて枠から出たときだけ消す。
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  // 選択ツールバーは閉じたあとも短い遷移の間だけ state に残す。dismissed は Esc や
  // 外側の押下で閉じたあと、選択が変わるまで出し直さないための印。
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null);
  const dismissed = useRef(false);

  const setPinned = (next: boolean) => {
    pinned.current = next;
    setAtBottom(next);
  };

  // 簡略中は expanded を効かせない。状態は書き換えないので、通常の高さに戻れば再び効く。
  const expanded = expandedOpen && !compact;

  // 要対応の間は端末を見たいので、会話の取得も止める。戻ったらその場で取り直す。
  const blocked = pane.agentStatus === "blocked";
  const {
    snapshot: serverSnapshot,
    failed: chatFailed,
    refresh: refreshChat,
  } = usePaneChat(pane.id, pane.chat, pane.chat && !blocked, pane.agentStatus);
  // 実行中の段階は pi 拡張の sidecar からだけ取る（ADR 0035）。
  const activity = usePaneActivity(
    pane.id,
    pane.agent === "pi" && pane.chat && !blocked,
    pane.agentStatus,
  );
  // 分割セルも含め、見出しごとに引く。同じスペースのセルは同じ PR になる。
  const pullRequest = usePullRequest(context.workspaceId, branch);
  const resetting = sessionReset !== null && newSessionPending(sessionReset, serverSnapshot);
  const snapshot = resetting ? newSessionSnapshot(serverSnapshot) : serverSnapshot;
  const normalBody = paneBody({
    chat: pane.chat || resetting,
    blocked,
    failed: chatFailed && !resetting,
    snapshot,
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
  const body = readOnly ? { kind: "output" as const } : normalBody;
  // 新しく届いた返答を一度に描くと、長いときに先頭がスクロールの外へ流れる。
  // 演出は会話を出している間だけ。初期表示と入れ替えでは再生しない。
  // /new のマスク中は空の表示用スナップショットなので、比較させない。渡すと
  // マスクが解けて元の会話へ戻るときに末尾の返答を追記と誤認する。
  const reveal = useMessageReveal(resetting || body.kind !== "chat" ? null : body.snapshot);
  // 起動待ちの間は、端末に届いている途中の画面（シェルの起動コマンド、TUI の描画中、
  // 空の会話）を出さない。何が届いていてもスケルトンに置き換える。
  const launching = starting && !readOnly;
  const confirmation =
    view === "confirm" && interaction?.kind === "folder-trust" ? interaction : null;
  const output = read?.text ?? null;
  const outputEmpty = output !== null && output.trim() === "";
  const replying = pane.agentStatus === "working";
  // /compact の開始を観測できたときだけ、完了までの所要時間をログに添える。
  // リロードやペイン切り替えでは失う（永続化は別スコープ）。
  const [compactionRun, setCompactionRun] = useState<{
    startedAt: number;
    baselineAt: number | null;
  } | null>(null);
  const [compactionNow, setCompactionNow] = useState(() => Date.now());
  const compactionSawWorking = useRef(false);
  const [compactionDuration, setCompactionDuration] = useState<{
    at: number;
    ms: number;
  } | null>(null);
  const [compactionEcho, setCompactionEcho] = useState<{
    text: string;
    at: number;
    completedAt: number | null;
  } | null>(null);
  const markCompaction = (baselineAt: number | null, text: string) => {
    const startedAt = Date.now();
    compactionSawWorking.current = false;
    setCompactionNow(startedAt);
    setCompactionEcho({ text, at: startedAt, completedAt: null });
    setCompactionRun({ startedAt, baselineAt });
  };
  useEffect(() => {
    if (compactionRun === null) return;
    setCompactionNow(Date.now());
    const timer = window.setInterval(() => setCompactionNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [compactionRun]);
  useEffect(() => {
    if (compactionRun === null) return;
    const at = snapshot?.compaction?.at ?? null;
    // 新しい compaction が届いたら、開始からの差を所要時間として残す。
    if (at !== null && at !== compactionRun.baselineAt) {
      const ms = at - compactionRun.startedAt;
      if (ms > 0 && ms < 24 * 60 * 60 * 1000) setCompactionDuration({ at, ms });
      setCompactionEcho((echo) => (echo === null ? null : { ...echo, completedAt: at }));
      setCompactionRun(null);
      return;
    }
    // 手動の /compact は Herdr の agent_status を working にしない。working を観測
    // できた場合だけ idle 復帰を失敗とみなし、それ以外は完了か上限まで待つ。
    if (replying) {
      compactionSawWorking.current = true;
      return;
    }
    if (compactionSawWorking.current) {
      const timer = window.setTimeout(() => {
        setCompactionRun((run) => (run === compactionRun ? null : run));
      }, 3000);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(
      () => {
        setCompactionRun((run) => (run === compactionRun ? null : run));
      },
      10 * 60 * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [compactionRun, replying, snapshot?.compaction?.at]);
  const compactionElapsedMs =
    compactionRun === null ? null : Math.max(0, compactionNow - compactionRun.startedAt);
  const compacting = !resetting && compactionRun !== null;
  const visibleCompactionEcho = resetting ? null : compactionEcho;
  const chatEmpty =
    body.kind === "chat" &&
    body.snapshot.messages.length === 0 &&
    body.snapshot.compaction === null &&
    pendingMessages.length === 0 &&
    !compacting &&
    visibleCompactionEcho === null &&
    !replying;
  const empty =
    !launching && (body.kind === "chat" ? chatEmpty : body.kind === "output" && outputEmpty);
  const info = agentInfo(snapshot);
  // モデルと effort が無くても、コンテキストの材料があれば行を出す。
  const meter = contextMeter(snapshot?.context ?? null);
  const content = body.kind === "chat" ? body.snapshot.messages : output;

  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // 引用を足した直後、再描画後の入力欄へカーソルを移す位置。
  const pendingCaret = useRef<number | null>(null);
  // 選択ツールバーを出している間は自動追従を止める。購読を張り直さずに読むため ref に写す。
  const quoting = useRef(false);
  quoting.current = selectionToolbar !== null;

  const shell = isShellPane(pane);
  // シェルには会話のコマンドが無い。エージェントを終了したときにチップが残っていても、
  // シェルの入力欄では見せず、送信も本文として扱う。
  const activeChip = shell ? null : chip;
  const compactDone = snapshot !== null && compactAlreadyDone(snapshot);
  // 添付を持っている間は候補を出さない。候補を選ぶと本文が消えるので、貼った画像と
  // 書きかけの指示が別々のメッセージに分かれてしまう。引用は下書きの一部なので、
  // 本文の先頭が `/` でなければ候補は出ない。空の会話と圧縮済みは commandAvailable が見る。
  const candidates =
    attachments.length === 0 && compactionRun === null
      ? commandCandidates(pane, draft, snapshot)
      : [];
  const uploading = attachments.some((item) => item.name === null);
  const sendable = canSend({
    uploading,
    chip: activeChip,
    replying,
    draft,
    attachments: attachments.length,
  });
  // 停止は入力が空のときだけ出す。文字・添付・引用があれば、送信は実行中への追加指示になる。
  const stop = canStop({
    replying,
    agent: pane.agent,
    running,
    draft,
    attachments: attachments.length,
    chip: activeChip,
  });
  const busy = sending || stopping;
  const placeholder =
    activeChip === "compact" ? "圧縮の指示（任意）" : shell ? "コマンドを入力" : "メッセージを入力";

  // シェルに戻ったら、会話のコマンドチップは持ち越さない。残すと、シェルへ
  // /compact を送ってしまい、次の会話に圧縮の控えが並ぶ。
  useEffect(() => {
    if (!shell) return;
    setChip((current) => (current === null ? current : null));
  }, [shell]);

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

  // 打つたびに書くと重いので、手が止まってから残す。compact チップ中の draft は
  // 指示であり、復元するとチップが無いぶん本文として送られてしまうので保存しない。
  useEffect(() => {
    if (activeChip === "compact") return;
    const text = draft;
    const timer = setTimeout(() => writeDraft(storage(), pane.id, text), 250);
    return () => clearTimeout(timer);
  }, [draft, pane.id, activeChip]);

  // 選択ツールバーは、選択の始まりと終わりがスクロール領域の中にあるときだけ出す。
  // マウスのドラッグ中は selectionchange が動くたびに発火するので評価せず、ボタンを
  // 離した pointerup で確定した選択を見る。キーボードの選択変更はそのまま拾う。
  // スクロール・リサイズでは位置を追い、選択が領域の外へ出たら閉じる。
  useEffect(() => {
    const scrollerElement = scroller.current;
    const frameElement = frame.current;
    if (scrollerElement === null || frameElement === null) return;
    if (touchFirst()) {
      setSelectionToolbar(null);
      return;
    }

    dismissed.current = false;
    setSelectionToolbar(null);
    let dragging = false;
    let frameRequest = 0;

    const close = () => {
      setSelectionToolbar((current) => (current === null ? null : { ...current, open: false }));
    };
    const refresh = () => {
      if (dragging || dismissed.current) return;
      const anchor = readSelectionAnchor(scrollerElement, frameElement);
      if (anchor === null) close();
      else setSelectionToolbar({ anchor, open: true });
    };
    const scheduleRefresh = () => {
      if (frameRequest !== 0) return;
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        refresh();
      });
    };
    const onSelectionChange = () => {
      dismissed.current = false;
      refresh();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-selection-toolbar]") !== null) {
        return;
      }
      dragging = true;
      dismissed.current = true;
      close();
    };
    const stopDragging = () => {
      if (!dragging) return;
      dragging = false;
      refresh();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismissed.current = true;
      close();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", stopDragging);
    document.addEventListener("pointercancel", stopDragging);
    document.addEventListener("keydown", onKeyDown);
    // 窓の外で離すと pointerup が来ない。次のキーボード選択までドラッグ中のままにしない。
    window.addEventListener("blur", stopDragging);
    scrollerElement.addEventListener("scroll", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    return () => {
      if (frameRequest !== 0) cancelAnimationFrame(frameRequest);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", stopDragging);
      document.removeEventListener("pointercancel", stopDragging);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", stopDragging);
      scrollerElement.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
    };
  }, [pane.id]);

  // 送信で空にしたときも、高さを初期状態へ戻す。分割枚数が変わって簡略が切り替わったときも、
  // 前の inline height を残さない。
  // 描画の後に高さを直すと、改行した 1 フレームだけ箱が低いままになり、
  // スクロールバーが一瞬出る。描画の前に合わせる。
  useLayoutEffect(() => {
    fit(input.current, expanded);
  }, [draft, expanded, compact, readOnly]);

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

  // 最新が見えている間だけ追従する。読み返しているときは勝手に動かさない。
  // 失敗の notice はメッセージ領域を縮めるので、出たときも追従し直す。
  // 圧縮の吹き出しと進捗行は chat の末尾にローカルで足すため、content が変わらない
  // 間も追従できるよう compactionRun / compactionEcho も依存に入れる。
  useEffect(() => {
    if (confirmation !== null) return;
    const element = scroller.current;
    if (element && atBottom && !quoting.current) element.scrollTop = element.scrollHeight;
  }, [
    content,
    replying,
    atBottom,
    pendingMessages.length,
    // 逐次表示は本文が伸びるたびに底へ寄せる。伸びなければ何もしない。
    reveal?.text.length,
    notice,
    compactionRun,
    compactionEcho,
    confirmation?.id,
  ]);

  // 画像の読み込みや入力欄の伸びで高さが後から変わっても、最新を見ている間は底に留める。
  // 画像の load は bubble しないので capture で拾い、領域の伸縮は ResizeObserver で拾う。
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const keep = () => {
      lastHeight.current = element.scrollHeight;
      lastClientHeight.current = element.clientHeight;
      if (confirmation !== null || !pinned.current || quoting.current) return;
      element.scrollTop = element.scrollHeight;
    };
    // 初回は今の高さを基準にする。0 のまま残すと、最初のスクロールを伸縮と誤認する。
    lastHeight.current = element.scrollHeight;
    lastClientHeight.current = element.clientHeight;
    element.addEventListener("load", keep, true);
    const observer = new ResizeObserver(keep);
    observer.observe(element);
    return () => {
      element.removeEventListener("load", keep, true);
      observer.disconnect();
    };
  }, [confirmation?.id]);

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

  const jumpToLatest = () => {
    setPinned(true);
    const element = scroller.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  // 候補を選ぶとチップになり、入力欄の /... は消える。送信はもう一度 Enter。
  const pick = (id: CommandId) => {
    setChip(id);
    setDraft("");
    // タップでキーボードが閉じないよう、入力欄へ焦点を戻す。
    input.current?.focus();
  };

  const clearChip = () => {
    setChip(null);
    setDraft("");
    input.current?.focus();
  };

  // 選択を引用として下書きの末尾へ足す。compact のチップは外すが、指示の下書きは残す
  // （引用に続く本文として送り、/compact には戻さない。ADR 0016 / 0062）。
  const quoteSelection = () => {
    // 送信中に足すと、成功時のクリアで新しい引用まで消える。送っている間は受け付けない。
    if (sending) return;
    const text = selectionToolbar?.anchor.text ?? "";
    if (text === "") return;
    const next = appendQuote(draft, text);
    setDraft(next.text);
    setChip(null);
    pendingCaret.current = next.caret;
    dismissed.current = true;
    document.getSelection()?.removeAllRanges();
    setSelectionToolbar((current) => (current === null ? null : { ...current, open: false }));
  };

  const openProjects = () => setProjectDialog({ open: true, caret: null });

  const closeProjects = () =>
    setProjectDialog((current) => (current === null ? null : { ...current, open: false }));

  // 選んだプロジェクトは本文のカーソル位置へ入れる。チップは文字を打ったときと同じ規則で、
  // new は解除し、compact の指示は残す。
  const pickProject = (path: string) => {
    const field = input.current;
    const start = field?.selectionStart ?? draft.length;
    const end = field?.selectionEnd ?? start;
    const next = insertProjectPath(draft, start, end, path);
    setDraft(next.text);
    setChip(chipOnInput(activeChip));
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

  // 外した添付は送らない。進行中のアップロードも止める。保存先のファイルは消さない。
  const removeAttachment = (key: string) => attachmentStore.remove(pane.id, key);

  // ペインを切り替えても止めない。送り先が消えたときだけ App が中断する。
  const uploadImage = async (file: File) => {
    const { key, controller } = attachmentStore.begin(pane.id);

    const result = await uploadAttachment(pane.id, file, controller.signal);
    if (result.ok) {
      attachmentStore.settle(pane.id, key, result.name);
      return;
    }
    // 外された添付は一覧から既に消えている。その失敗は知らせない。
    if (controller.signal.aborted) return;
    attachmentStore.remove(pane.id, key);
    setNotice(uploadFailureNotice(result.status));
  };

  // 貼った画像を見たらコマンドではなく本文を書く。書きかけの draft は捨てない。
  const addImages = (files: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setNotice(ATTACHMENT_LIMIT_NOTICE);
      return;
    }
    if (files.length > room) setNotice(ATTACHMENT_LIMIT_NOTICE);
    setChip(null);
    for (const file of files.slice(0, room)) void uploadImage(file);
  };

  // ファイルのドラッグだけを扱う。テキストやページ内の要素のドラッグは既定動作のまま。
  const fileTransfer = (transfer: DataTransfer | null): DataTransfer | null => {
    if (transfer === null || !transfer.types.includes("Files")) return null;
    return transfer;
  };

  // 貼り付けとドロップで同じ受け付け方をする。未対応の形式は保存せず、その場で伝える。
  // アップロードする画像が無ければ既定動作を止めない（ADR 0018）。
  // 何もアップロードしないときは false を返し、呼び出し側に preventDefault させない。
  const takeImages = (action: AttachmentAction): boolean => {
    if (action.kind === "upload") {
      if (action.unsupported) setNotice(unsupportedImageNotice());
      addImages(action.files);
      return true;
    }
    if (action.kind === "unsupported") setNotice(unsupportedImageNotice());
    return false;
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
    names: string[];
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
        ...(echo.names.length === 0 ? {} : { attachments: echo.names }),
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
        setCompactionRun(null);
        setCompactionEcho(null);
        setCompactionDuration(null);
      } else setSessionReset(null);
      refreshChat();
    }
    return sent;
  };

  const sendText = async () => {
    if (readOnly || !sendable || sending) return;
    const names = attachments
      .map((item) => item.name)
      .filter((name): name is string => name !== null);
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
      // 250ms の debounce を待たずに消す。先にペインを切り替えると古い値が戻る。
      writeDraft(storage(), pane.id, "");
      setDraft("");
      attachmentStore.clear(pane.id);
      // シェルペインには会話が無い。控えを積むと、同じペインで後から起動した
      // エージェントの会話に、シェルで打ったコマンドが並ぶ。送信は端末にだけ届ける。
      if (!shell) {
        // /compact は user メッセージを残さない。送信カードを積むと最大 60 秒残るので、
        // 代わりに圧縮中の行を出す。
        if (compactCommand) {
          markCompaction(baselineAt, text);
        } else if (!newCommand) {
          echoPending({ text, at, from, waiting, after, names });
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
      setCompactionRun(null);
      setCompactionEcho(null);
    } else setNotice(STOP_FAILED_NOTICE);
    setStopping(false);
  };

  // /new は user 発話を残さないので、送信中バブルを積むと最大 60 秒残る。
  // compact は draft を指示として後ろに付ける。送れたときだけ両方空にする。
  const sendCommand = async (id: CommandId) => {
    if (readOnly || sending || replying || compactionRun !== null) return;
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
    !readOnly && !sending && compactionRun === null && commandAvailable(id, pane, snapshot);

  const runMenuCommand = async (id: CommandId) => {
    if (!menuCommandAvailable(id)) return;
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

  useImperativeHandle(props.outputRef, () => ({
    refreshOutput: () => {
      setPinned(true);
      setOutputVersion((version) => version + 1);
    },
  }));

  const submit = () => {
    if (readOnly) return;
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

  return (
    <>
      <div class="hwc-pane-head" data-bare={!labeled}>
        <span class="hwc-pane-head-icon" data-agent={agentGlyph(pane.agent)}>
          {pane.agent ? <AgentGlyphIcon agent={pane.agent} size={14} /> : <PaneIcon size={14} />}
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
        {labeled && showSpace && shownPaneName !== context.workspaceName ? (
          <span
            class="hwc-pane-head-space"
            title={`${context.workspaceLabel} / ${context.tabLabel}`}
          >
            {context.workspaceName}
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
      <div class="hwc-output-wrap" ref={frame}>
        <div
          class="hwc-output-scroll"
          data-empty={empty}
          ref={scroller}
          onScroll={(event) => {
            if (confirmation !== null) return;
            const element = event.currentTarget;
            const now = {
              scrollTop: element.scrollTop,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
            };
            const last = {
              scrollTop: now.scrollTop,
              clientHeight: lastClientHeight.current,
              scrollHeight: lastHeight.current,
            };
            lastHeight.current = now.scrollHeight;
            lastClientHeight.current = now.clientHeight;
            // 高さが変わっただけなら、底を詰めた副作用。読み返しの意思とはみなさない。
            // 縮んだ結果ブラウザが底へ寄せた場合に備え、追従の判断は今の位置で取り直す。
            // ただし縦に伸びたときは、伸びる前の底から離れた位置なら利用者が動かしたと
            // みなす。逐次表示は 150ms ごとに高さが変わるので、これが無いと上へ
            // スクロールしても高さの変化と誤認してすぐ底へ戻される。
            if (isLayoutShift(now, last)) {
              if (isUserScrollDuringGrowth(now, last)) {
                setPinned(isNearBottom(now));
                return;
              }
              if (pinned.current) element.scrollTop = element.scrollHeight;
              if (isNearBottom(now)) setPinned(true);
              return;
            }
            setPinned(isNearBottom(now));
          }}
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
                onOpenImage={onOpenImage}
                onOpenPreview={onOpenPreview}
                pending={pendingMessages}
                reveal={reveal}
              />
            </>
          ) : (
            <>
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
        {reveal === null || !atBottom ? null : <div class="hwc-output-fade" aria-hidden="true" />}
        {confirmation !== null ? null : (
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
        <SelectionToolbar
          state={selectionToolbar}
          canQuote={!readOnly && !starting && pane.chat}
          onQuote={quoteSelection}
          onCopy={() => {
            const selection = document.getSelection();
            const element = scroller.current;
            if (selection === null || selection.rangeCount === 0 || element === null) return "";
            return selectionCopyText(element, selection.getRangeAt(0));
          }}
          onExited={() => setSelectionToolbar(null)}
        />
      </div>

      {body.kind === "chat" ? (
        <LiveStatus
          open={replying || compacting}
          phase={livePhase}
          thought={liveThought}
          elapsedMs={compacting ? compactionElapsedMs : waitingMs}
          compacting={compacting}
          stopping={stopping}
          showThought={!compact && activity !== null}
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
      ) : starting ? (
        // 起動が終わるまで入力欄を出さない。相手がまだシェルだと、書いた文字が
        // そのまま端末へ届く。Spinner はこの行に 1 つだけ置く。
        <p class="hwc-starting" role="status" data-compact={compact}>
          <span class="hwc-starting-mark">
            <Spinner size={14} />
          </span>
          エージェントを起動しています。準備ができるまでメッセージは送れません。
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
            if (!pane.chat || fileTransfer(event.dataTransfer) === null) return;
            dragDepth.current += 1;
            setDropping(true);
          }}
          onDragOver={(event) => {
            const transfer = fileTransfer(event.dataTransfer);
            if (transfer === null) return;
            // 添付を受け付けないペインでもファイルを開かせない。ただし落とせる場所では
            // ないので、copy のカーソルは出さない。
            event.preventDefault();
            transfer.dropEffect = pane.chat ? "copy" : "none";
          }}
          onDragLeave={() => {
            if (dragDepth.current === 0) return;
            dragDepth.current -= 1;
            if (dragDepth.current === 0) setDropping(false);
          }}
          onDrop={(event) => {
            const transfer = fileTransfer(event.dataTransfer);
            if (transfer === null) return;
            // 画像以外のファイルもアップロードせず、ブラウザに開かせもしない。
            event.preventDefault();
            dragDepth.current = 0;
            setDropping(false);
            if (!pane.chat) return;
            takeImages(dropActionFrom(transfer.files));
          }}
        >
          <label class="hwc-visually-hidden" for={`hwc-input-${pane.id}`}>
            {context.workspaceLabel} / {context.tabLabel} のペインへ送る
          </label>
          <div class="hwc-input-frame">
            {compact ? null : (
              <button
                type="button"
                class="hwc-input-toggle"
                aria-expanded={expanded}
                aria-label={expanded ? "入力を折りたたむ" : "入力を広げる"}
                onClick={() => setExpandedOpen((current) => !current)}
              >
                {expanded ? <CollapseIcon /> : <ExpandIcon />}
              </button>
            )}
            {attachments.length > 0 ? (
              <div class="hwc-commands" role="group" aria-label="添付画像">
                {attachments.map((item) => {
                  const name = item.name;
                  return (
                    <span class="hwc-command hwc-attachment" data-chip="true" key={item.key}>
                      {name === null ? (
                        <span class="hwc-attachment-sending">送信中</span>
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
                value={draft}
                // 簡略時は placeholder を付けない。狭い入力欄で「メッセージを入力」が切れる。
                {...(compact ? {} : { placeholder })}
                onInput={(event) => {
                  setDraft(event.currentTarget.value);
                  setChip(chipOnInput(activeChip));
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
                  // 添付を受け付けるのは会話を持つペインだけ。
                  if (!pane.chat) return;
                  const action = pasteActionFrom(event.clipboardData?.items);
                  // テキストだけの貼り付けは入力欄の既定動作のままにする。
                  if (action.kind === "default") return;
                  if (takeImages(action)) event.preventDefault();
                }}
                onKeyDown={(event) => {
                  const composing = event.isComposing || event.keyCode === 229;
                  if (event.key !== "Enter") return;
                  if (composing) return;
                  // シェルは改行を受け取れない。タッチ端末でも Enter で送る。
                  const newline =
                    event.shiftKey ||
                    (!shell && enterInsertsNewline((query) => window.matchMedia(query).matches));
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
              {/* 入口を出すのはシェルだけ。会話を読めないエージェント（Claude など）は chat が
                  false になるので、chat ではなくペインの種類で分ける。 */}
              {compact ? null : shell ? (
                <button type="button" class="hwc-agent-start" onClick={startAgent}>
                  <AgentIcon size={16} />
                  エージェントを起動
                </button>
              ) : pane.chat ? (
                <ComposerAdd
                  full={attachments.length >= MAX_ATTACHMENTS}
                  commands={composerCommands}
                  onFiles={(files) => takeImages(dropActionFrom(files))}
                  onProjects={openProjects}
                />
              ) : null}
              <span class="hwc-input-tail">
                {info === null && meter === null ? null : (
                  <span class="hwc-input-info">
                    <span class="hwc-input-agent" data-agent={agentGlyph(pane.agent)}>
                      <AgentGlyphIcon agent={pane.agent} size={14} />
                    </span>
                    {info === null ? null : <AgentInfoHint info={info} />}
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
                  data-sending={sending}
                  data-stopping={stopping}
                  aria-label={stopping ? "停止中" : sending ? "送信中" : stop ? "停止" : "送信"}
                  disabled={busy || (!stop && !sendable)}
                  onClick={stop && !busy ? stopWorking : undefined}
                >
                  {busy ? <Spinner /> : stop ? <StopIcon /> : <SendIcon />}
                </button>
              </span>
            </div>
          </div>
        </form>
      )}
      {projectDialog === null ? null : (
        <ProjectDialog
          paneId={pane.id}
          open={projectDialog.open}
          onClose={closeProjects}
          onExited={projectsExited}
          onPick={pickProject}
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
