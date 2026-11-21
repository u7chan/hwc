import type { RefObject, TargetedEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage } from "../../server/chat/contract";
import type { PaneState } from "../../server/herdr/state";
import { attachmentKindOfFileName, MAX_ATTACHMENTS } from "../../shared/attachments";
import type { AttachedFile } from "../attachment-store";
import {
  ATTACHMENT_LIMIT_NOTICE,
  type AttachmentAction,
  attachmentTooLargeNotice,
  dropActionFrom,
  exceedsAttachmentLimit,
  pasteActionFrom,
  SHELL_NEWLINE_NOTICE,
} from "../attachments";
import { type CommandId, chipOnInput } from "../commands";
import { type EditSession, newRequestId } from "../edit";
import { FILE_REFERENCE_TYPE, insertFileReference } from "../file-reference";
import { projectMentionAllowed } from "../input";
import { insertProjectPath, projectMention, type ProjectMention } from "../projects";
import { appendQuote } from "../reply";
import type { SelectionToolbarState } from "../SelectionToolbar";
import { insertTemplate } from "../templates";
import { useDraft } from "./use-draft";

export type ComposerDialog = { open: boolean; caret: number | null };

type ComposerOptions = {
  pane: PaneState;
  // シェルのペインか。チップを見せず、改行も添付も受けない。
  shell: boolean;
  // 入力欄を閉じている（閲覧のみ・応答待ち）か。古い描画からの操作を落とす。
  inputDisabled: boolean;
  // 起動の待ちで、送信・添付・コマンドを受け付けないか。
  launchBlocked: boolean;
  // 送信中か。成功時のクリアが新しい引用まで消さないよう、送っている間は引用を受けない。
  sending: boolean;
  // 添付の一覧。上限の判定と、送信中のチップに使う。
  attachments: readonly AttachedFile[];
  // 選択の引用。範囲の文字はツールバーが持ち、閉じるのもその hook。
  selection: {
    toolbar: SelectionToolbarState | null;
    dismiss: () => void;
  };
  // 入力欄の要素と高さ。中身を描き替えても高さを保つため、PaneDetail が持つ。
  input: {
    field: RefObject<HTMLTextAreaElement | null>;
    // 引用や挿入のあと、再描画された入力欄へ戻すキャレット。
    pendingCaret: RefObject<number | null>;
    fit: (field: HTMLTextAreaElement | null, open: boolean) => void;
    expanded: boolean;
  };
  // 添付の保存。失敗したときだけ、知らせる文言を返す。
  upload: (file: File) => Promise<string | null>;
};

export type Composer = {
  // チップは id だけを持つ。シェルでは見せないので、表示と送信は activeChip を使う。
  activeChip: CommandId | null;
  // 編集は対象 id・requestId・本文だけを持つ。下書き (draft) は触らない。
  edit: EditSession | null;
  // 編集中は入力欄の値を編集本文へ流し、下書きはそのまま残す。
  inputText: string;
  draft: string;
  // 送信・コマンドの成否を出す行。入力欄の外（LiveStatus の下）に描く。
  notice: string | null;
  // `@` の候補を出すかは、本文とキャレットから描画のたびに導く。
  mention: ProjectMention | null;
  // 閉じた記録と一致する間は、同じ `@語` でも候補を出し直さない。
  mentionClosed: boolean;
  mentionHighlight: string | null;
  projectDialog: ComposerDialog | null;
  templateDialog: ComposerDialog | null;
  // メニューからの /new だけ、送る前に確認する。
  confirmNew: boolean;
  dropping: boolean;
  // 入力欄。高さを測る effect からも使うので、要素そのものを返す。
  field: RefObject<HTMLTextAreaElement | null>;
  // 送信・編集の処理は PaneDetail に残す。結果だけを受け取って状態を進める。
  setDraft: (value: string) => void;
  clearDraft: () => void;
  setChip: (value: CommandId | null) => void;
  setEdit: (value: EditSession | null) => void;
  setEditSending: (sending: boolean) => void;
  setNotice: (value: string | null) => void;
  setConfirmNew: (open: boolean) => void;
  setMentionHighlight: (path: string | null) => void;
  // 送る直前の後片付け。前の失敗を消し、キーボードを閉じて出力を見せる。
  beginSend: () => void;
  beginEdit: (message: ChatMessage) => void;
  cancelEdit: () => void;
  // 候補を選ぶとチップになり、入力欄の /... は消える。送信はもう一度 Enter。
  pick: (id: CommandId) => void;
  clearChip: () => void;
  onInput: (event: TargetedEvent<HTMLTextAreaElement, InputEvent>) => void;
  onBlur: (event: TargetedEvent<HTMLTextAreaElement, FocusEvent>) => void;
  syncCaret: (field: HTMLTextAreaElement) => void;
  onPaste: (event: TargetedEvent<HTMLTextAreaElement, ClipboardEvent>) => void;
  // ファイルをドラッグしている間だけ composer を光らせる。dragenter / dragleave は
  // 子要素をまたぐたびに入れ替わるので、深さを数えて枠から出たときだけ消す。
  drag: {
    enter: (event: TargetedEvent<HTMLFormElement, DragEvent>) => void;
    over: (event: TargetedEvent<HTMLFormElement, DragEvent>) => void;
    leave: () => void;
    drop: (event: TargetedEvent<HTMLFormElement, DragEvent>) => void;
  };
  quoteSelection: () => void;
  openProjects: () => void;
  closeProjects: () => void;
  pickProject: (path: string) => void;
  projectsExited: () => void;
  openTemplates: () => void;
  closeTemplates: () => void;
  pickTemplate: (body: string) => void;
  templatesExited: () => void;
  pickMention: (path: string) => void;
  dismissMention: () => void;
  // 貼り付けとドロップの受け付け。アップロードするファイルが無ければ既定動作を止めない。
  takeFiles: (action: AttachmentAction) => boolean;
};

// composer のローカルな UI state と、その遷移。送信・編集の API 呼び出しは PaneDetail に残し、
// ここは値と handler を受け取って画面の状態だけを進める。下書きの保存可否はチップの状態で
// 決まるので、下書きはこの hook から useDraft を呼ぶ。
export function useComposer(options: ComposerOptions): Composer {
  const {
    pane,
    shell,
    inputDisabled,
    launchBlocked,
    sending,
    attachments,
    selection,
    input,
    upload,
  } = options;
  // チップは id だけを持つ。表示名と送信文字列は定数から引く。
  const [chip, setChipState] = useState<CommandId | null>(null);
  // 編集は対象 id・requestId・本文だけを持つ。下書き (draft) は触らない。
  const [edit, setEditState] = useState<EditSession | null>(null);
  // メニューからの /new だけ、送る前に確認する。
  const [confirmNew, setConfirmNew] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // プロジェクトのダイアログは閉じるアニメーションの間も残す。caret は選んだ直後に
  // 入力欄へ戻す位置で、閉じただけ（キャンセル）のときは null のまま。
  const [projectDialog, setProjectDialog] = useState<ComposerDialog | null>(null);
  // `@` の候補を出すかは、本文とキャレットから描画のたびに導く。キャレットは入力欄が
  // 持つ値の写しで、フォーカスを外している間は null。強調と閉じた記録も識別子だけを持つ。
  const [caret, setCaret] = useState<number | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState<string | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState<ProjectMention | null>(null);
  // 定型文のダイアログも、閉じるアニメーションの間は残す。caret は選んだ直後に
  // 入力欄へ戻す位置で、閉じただけのときは null のまま。
  const [templateDialog, setTemplateDialog] = useState<ComposerDialog | null>(null);
  // ファイルをドラッグしている間だけ composer を光らせる。dragenter / dragleave は
  // 子要素をまたぐたびに入れ替わるので、深さを数えて枠から出たときだけ消す。
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  // ツリーの行を掴むと入力欄からフォーカスが外れる。その直前の選択範囲を控え、
  // 落としたときの差し込み位置にする。一度もフォーカスしていなければ null。
  const lastSelection = useRef<{ start: number; end: number } | null>(null);

  // シェルには会話のコマンドが無い。エージェントを終了したときにチップが残っていても、
  // シェルの入力欄では見せず、送信も本文として扱う。
  const activeChip = shell ? null : chip;
  // 下書きの保存可否はチップで決まる（compact の指示は本文として復元しない）。チップと
  // 同じ hook に置かないと、PaneDetail 側でどちらを先に呼ぶかが循環する。
  const { draft, setDraft, clearDraft } = useDraft(pane.id, activeChip !== "compact");
  const inputText = edit === null ? draft : edit.text;

  // 編集中は入力欄の値を編集本文へ流し、下書きはそのまま残す。
  const setInputText = (value: string) => {
    if (edit !== null) {
      setEditState((current) => (current === null ? current : { ...current, text: value }));
      return;
    }
    setDraft(value);
    setChipState(chipOnInput(activeChip));
  };

  const mention =
    caret !== null &&
    !shell &&
    pane.chat &&
    edit === null &&
    !launchBlocked &&
    !inputDisabled &&
    projectMentionAllowed((query) => window.matchMedia(query).matches)
      ? projectMention(draft, caret)
      : null;
  const mentionClosed =
    mention !== null &&
    mentionDismissed !== null &&
    mentionDismissed.start === mention.start &&
    mentionDismissed.query === mention.query;

  // シェルに戻ったら、会話のコマンドチップは持ち越さない。残すと、シェルへ
  // /compact を送ってしまい、次の会話に圧縮の控えが並ぶ。
  useEffect(() => {
    if (!shell) return;
    setChipState((current) => (current === null ? current : null));
  }, [shell]);

  // 候補を選ぶとチップになり、入力欄の /... は消える。送信はもう一度 Enter。
  // 起動中は候補を出さないが、古い描画からのクリックでも下書きを消さない。
  const pick = (id: CommandId) => {
    if (launchBlocked || inputDisabled || edit !== null) return;
    setChipState(id);
    setDraft("");
    // タップでキーボードが閉じないよう、入力欄へ焦点を戻す。
    input.field.current?.focus();
  };

  const clearChip = () => {
    if (edit !== null) return;
    setChipState(null);
    setDraft("");
    input.field.current?.focus();
  };

  const syncCaret = (field: HTMLTextAreaElement) =>
    setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : null);

  const onInput = (event: TargetedEvent<HTMLTextAreaElement, InputEvent>) => {
    setInputText(event.currentTarget.value);
    syncCaret(event.currentTarget);
    setMentionDismissed(null);
    setMentionHighlight(null);
  };

  const onBlur = (event: TargetedEvent<HTMLTextAreaElement, FocusEvent>) => {
    const field = event.currentTarget;
    lastSelection.current = {
      start: field.selectionStart,
      end: field.selectionEnd,
    };
    setCaret(null);
  };

  // 選択を引用として下書きの末尾へ足す。compact のチップは外すが、指示の下書きは残す
  // （引用に続く本文として送り、/compact には戻さない）。
  const quoteSelection = () => {
    // 送信中に足すと、成功時のクリアで新しい引用まで消える。送っている間は受け付けない。
    if (sending || edit?.sending === true || launchBlocked || inputDisabled) return;
    const text = selection.toolbar?.anchor.text ?? "";
    if (text === "") return;
    const next = appendQuote(inputText, text);
    setInputText(next.text);
    if (edit === null) setChipState(null);
    input.pendingCaret.current = next.caret;
    selection.dismiss();
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
      const field = input.field.current;
      if (field === null) return;
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
      return;
    }
    setInputText(next.text);
    input.pendingCaret.current = next.caret;
  };

  // OS から落としたファイルと、ツリーの行を運んだドロップを同じ受け口で扱う。
  // dragover 中は getData を読めない（保護モード）ので、種類は型だけで決める。
  const dropKind = (transfer: DataTransfer | null): "files" | "reference" | null => {
    if (transfer === null) return null;
    if (transfer.types.includes(FILE_REFERENCE_TYPE)) return "reference";
    if (transfer.types.includes("Files")) return "files";
    return null;
  };

  // 添付の保存は PaneDetail が持ち、失敗したときだけ文言を返す。ここではそれを出す。
  const uploadFailure = async (file: File) => {
    const failure = await upload(file);
    if (failure !== null) setNotice(failure);
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
    setChipState(null);
    for (const file of files.slice(0, room)) {
      if (exceedsAttachmentLimit(file)) {
        setNotice(attachmentTooLargeNotice(attachmentKindOfFileName(file.name)));
        continue;
      }
      void uploadFailure(file);
    }
  };

  // 貼り付けとドロップで同じ受け付け方をする。アップロードするファイルが無ければ
  // 既定動作を止めない。何もアップロードしないときは false を返す。
  const takeFiles = (action: AttachmentAction): boolean => {
    if (action.kind !== "upload") return false;
    addFiles(action.files);
    return true;
  };

  const onPaste = (event: TargetedEvent<HTMLTextAreaElement, ClipboardEvent>) => {
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
      input.fit(field, input.expanded);
      return;
    }
    // 添付を受け付けるのは会話を持つペインだけ。起動中はテキストだけ。
    if (edit !== null || !pane.chat || launchBlocked || inputDisabled) return;
    const action = pasteActionFrom(event.clipboardData?.items);
    // テキストだけの貼り付けは入力欄の既定動作のままにする。
    if (action.kind === "default") return;
    if (takeFiles(action)) event.preventDefault();
  };

  const drag = {
    enter: (event: TargetedEvent<HTMLFormElement, DragEvent>) => {
      const transfer = event.dataTransfer;
      if (launchBlocked || inputDisabled || edit !== null || !pane.chat) return;
      if (transfer === null || dropKind(transfer) === null) return;
      dragDepth.current += 1;
      setDropping(true);
    },
    over: (event: TargetedEvent<HTMLFormElement, DragEvent>) => {
      const transfer = event.dataTransfer;
      if (transfer === null || dropKind(transfer) === null) return;
      // 添付を受け付けないペインでもファイルを開かせない。ただし落とせる場所では
      // ないので、copy のカーソルは出さない。
      event.preventDefault();
      transfer.dropEffect =
        pane.chat && !launchBlocked && !inputDisabled && edit === null ? "copy" : "none";
    },
    leave: () => {
      if (dragDepth.current === 0) return;
      dragDepth.current -= 1;
      if (dragDepth.current === 0) setDropping(false);
    },
    drop: (event: TargetedEvent<HTMLFormElement, DragEvent>) => {
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
    },
  };

  const openProjects = () => setProjectDialog({ open: true, caret: null });

  const closeProjects = () =>
    setProjectDialog((current) => (current === null ? null : { ...current, open: false }));

  // 選んだプロジェクトは本文のカーソル位置へ入れる。チップは文字を打ったときと同じ規則で、
  // new は解除し、compact の指示は残す。
  const pickProject = (path: string) => {
    const field = input.field.current;
    const start = field?.selectionStart ?? inputText.length;
    const end = field?.selectionEnd ?? start;
    const next = insertProjectPath(inputText, start, end, path);
    setInputText(next.text);
    if (edit === null) setChipState(chipOnInput(activeChip));
    setProjectDialog({ open: false, caret: next.caret });
  };

  // キャンセル時は DialogShell が開く前の要素（+ ボタン）へ戻す。選んだときだけ、
  // 閉じるアニメーションの後に本文へフォーカスを移す。
  const projectsExited = () => {
    const nextCaret = projectDialog?.caret ?? null;
    setProjectDialog(null);
    if (nextCaret === null) return;
    const field = input.field.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(nextCaret, nextCaret);
    input.fit(field, input.expanded);
  };

  // `@語` を選んだパスで置き換える。ダイアログと違い入力欄から離れないので、
  // キャレットは再描画の後に layout effect が戻す。
  const pickMention = (path: string) => {
    if (mention === null) return;
    const next = insertProjectPath(inputText, mention.start, mention.end, path);
    setInputText(next.text);
    setCaret(next.caret);
    setMentionHighlight(null);
    input.pendingCaret.current = next.caret;
  };

  const dismissMention = () => {
    if (mention === null) return;
    setMentionDismissed(mention);
  };

  const openTemplates = () => setTemplateDialog({ open: true, caret: null });

  const closeTemplates = () =>
    setTemplateDialog((current) => (current === null ? null : { ...current, open: false }));

  // 選んだ本文はカーソル位置へ入れる。チップは文字を打ったときと同じ規則で、
  // new は解除し、compact の指示は残す。
  const pickTemplate = (body: string) => {
    const field = input.field.current;
    const start = field?.selectionStart ?? inputText.length;
    const end = field?.selectionEnd ?? start;
    const next = insertTemplate(inputText, start, end, body);
    setInputText(next.text);
    if (edit === null) setChipState(chipOnInput(activeChip));
    setTemplateDialog({ open: false, caret: next.caret });
  };

  // キャンセル時は DialogShell が開く前の要素（+ ボタン）へ戻す。選んだときだけ、
  // 閉じるアニメーションの後に本文へフォーカスを移す。
  const templatesExited = () => {
    const nextCaret = templateDialog?.caret ?? null;
    setTemplateDialog(null);
    if (nextCaret === null) return;
    const field = input.field.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(nextCaret, nextCaret);
    input.fit(field, input.expanded);
  };

  // 過去の発言を入力欄へ移す。下書きはそのまま残し、編集中だけ別の本文を使う。
  const beginEdit = (message: ChatMessage) => {
    if (edit !== null || inputDisabled || launchBlocked) return;
    setNotice(null);
    setChipState(null);
    setEditState({
      messageId: message.id,
      requestId: newRequestId(),
      text: message.text,
      sending: false,
    });
    requestAnimationFrame(() => {
      const field = input.field.current;
      if (field === null) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  };

  const cancelEdit = () => {
    if (edit === null || edit.sending) return;
    setEditState(null);
    setNotice(null);
    input.field.current?.focus();
  };

  const beginSend = () => {
    setNotice(null);
    input.field.current?.blur();
  };

  return {
    activeChip,
    edit,
    inputText,
    draft,
    notice,
    mention,
    mentionClosed,
    mentionHighlight,
    projectDialog,
    templateDialog,
    confirmNew,
    dropping,
    field: input.field,
    setDraft,
    clearDraft,
    setChip: setChipState,
    setEdit: setEditState,
    setEditSending: (next) =>
      setEditState((current) => (current === null ? current : { ...current, sending: next })),
    setNotice,
    setConfirmNew,
    setMentionHighlight,
    beginSend,
    beginEdit,
    cancelEdit,
    pick,
    clearChip,
    onInput,
    onBlur,
    syncCaret,
    onPaste,
    drag,
    quoteSelection,
    openProjects,
    closeProjects,
    pickProject,
    projectsExited,
    openTemplates,
    closeTemplates,
    pickTemplate,
    templatesExited,
    pickMention,
    dismissMention,
    takeFiles,
  };
}
