import { type ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatCompaction, ChatFile, ChatMessage } from "../../server/chat/contract";
import { messageFileLabel } from "../../shared/message-files";
import { attachmentUrl, chatFileUrl } from "../api";
import { compactionLabel, messageFileKindLabel, splitInlineImages } from "../chat";
import { ChevronRightIcon, EyeIcon, StatusMark } from "../icons";
import { Markdown } from "../Markdown";
import { formatClock, formatElapsed } from "../time";

const USER_MESSAGE_CLAMP_LINES = 5;
const USER_MESSAGE_CLAMP_FALLBACK = 128;

function MessageAttachments(props: {
  paneId: string;
  names: string[];
  onOpen: (url: string, name: string) => void;
}) {
  return (
    <div class="hwc-msg-attachments">
      {props.names.map((name) => {
        const url = attachmentUrl(props.paneId, name);
        return (
          <button
            type="button"
            class="hwc-msg-attachment"
            key={name}
            aria-label="添付画像を拡大"
            aria-haspopup="dialog"
            onClick={() => props.onOpen(url, name)}
          >
            <img class="hwc-msg-attachment-image" src={url} alt="" loading="lazy" />
          </button>
        );
      })}
    </div>
  );
}

// エージェントが本文で示したファイル。画像はユーザーの添付と同じ見た目で拡大し、
// HTML はプレビューのタブで開く（ADR 0051）。
function MessageFiles(props: {
  paneId: string;
  files: ChatFile[];
  onOpen: (url: string, name: string) => void;
  onPreview: (file: ChatFile) => void;
}) {
  const images = props.files.filter((file) => file.kind === "image");
  const pages = props.files.filter((file) => file.kind === "html");
  return (
    <>
      {images.length === 0 ? null : (
        <div class="hwc-msg-attachments">
          {images.map((file) => {
            const url = chatFileUrl(props.paneId, file);
            const label = messageFileLabel(file.name);
            return (
              <button
                type="button"
                class="hwc-msg-attachment"
                key={`${file.name}@${file.version}`}
                aria-label={`${label} を拡大`}
                aria-haspopup="dialog"
                onClick={() => props.onOpen(url, label)}
              >
                <img class="hwc-msg-attachment-image" src={url} alt="" loading="lazy" />
              </button>
            );
          })}
        </div>
      )}
      {pages.length === 0 ? null : (
        <div class="hwc-msg-pages">
          {pages.map((file) => (
            <button
              type="button"
              class="hwc-msg-page"
              key={`${file.name}@${file.version}`}
              title={file.name}
              onClick={() => props.onPreview(file)}
            >
              <EyeIcon size={16} />
              <span class="hwc-msg-page-name">{messageFileLabel(file.name)}</span>
              <span class="hwc-msg-page-kind">{messageFileKindLabel(file.rootLabel)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// 根の外にあったファイル。hwc は根の外を配信しないので、チップを出せない理由だけを
// 1 行で示す（ADR 0065 outside-preview-root, 0066）。移すかどうかは会話で決める。
function OutsideFileNote(props: { name: string }) {
  return (
    <p class="hwc-msg-outside">
      <span class="hwc-msg-outside-name">{props.name}</span> はチェックアウトと /tmp
      の外にあるため、プレビューできません
    </p>
  );
}

// 画像記法の位置に描いた画像は、末尾の一覧から外す。裸パスだけの画像と HTML は
// 本文に位置が無いので、今までどおりメッセージの後ろに並べる。
export function AgentMessage(props: {
  paneId: string;
  message: ChatMessage;
  taskScope: string;
  copyButton: ComponentChildren;
  // 逐次表示の途中は本文がまだ途中。末尾の一覧と根の外の注記は、本文が出きってから出す。
  complete?: boolean;
  onOpenImage: (url: string, name: string) => void;
  onOpenPreview: (file: ChatFile) => void;
}) {
  const { images, rest } = splitInlineImages(props.paneId, props.message.text, props.message.files);
  const complete = props.complete !== false;
  return (
    <>
      <Markdown
        text={props.message.text}
        taskScope={props.taskScope}
        images={images}
        onOpenImage={props.onOpenImage}
      />
      {!complete || rest.length === 0 ? null : (
        <MessageFiles
          paneId={props.paneId}
          files={rest}
          onOpen={props.onOpenImage}
          onPreview={props.onOpenPreview}
        />
      )}
      {!complete || props.message.outsideFile === undefined ? null : (
        <OutsideFileNote name={props.message.outsideFile} />
      )}
      {complete ? (
        <div class="hwc-msg-meta">
          <span class="hwc-msg-time">{formatClock(props.message.at)}</span>
          {props.copyButton}
        </div>
      ) : null}
    </>
  );
}

export function UserMessage(props: {
  paneId: string;
  message: ChatMessage;
  copyButton: ComponentChildren;
  onOpenImage: (url: string, name: string) => void;
  pending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const [lineHeight, setLineHeight] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const textId = `hwc-msg-text-${props.message.id}`;

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      setContentHeight(element.scrollHeight);
      setLineHeight(Number.parseFloat(getComputedStyle(element).lineHeight) || 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.message.text]);

  const clampHeight =
    lineHeight > 0 ? lineHeight * USER_MESSAGE_CLAMP_LINES : USER_MESSAGE_CLAMP_FALLBACK;
  const overflowing = contentHeight > clampHeight + 1;

  return (
    <>
      <div class="hwc-msg-bubble">
        {props.message.text === "" ? null : (
          <div
            class="hwc-msg-body"
            id={textId}
            ref={content}
            style={{ maxHeight: `${expanded ? contentHeight : clampHeight}px` }}
          >
            {props.message.text}
            {overflowing && !expanded ? (
              <span class="hwc-msg-more" aria-hidden="true">
                …
              </span>
            ) : null}
          </div>
        )}
        {overflowing ? (
          <button
            type="button"
            class="hwc-msg-expand"
            aria-expanded={expanded}
            aria-controls={textId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{expanded ? "閉じる" : "もっとみる"}</span>
            <span class="hwc-msg-expand-icon">
              <ChevronRightIcon size={16} />
            </span>
          </button>
        ) : null}
        {props.message.attachments === undefined ? null : (
          <MessageAttachments
            paneId={props.paneId}
            names={props.message.attachments}
            onOpen={props.onOpenImage}
          />
        )}
      </div>
      <div class="hwc-msg-meta">
        {props.copyButton}
        <span class="hwc-msg-time">{props.pending ? "送信中" : formatClock(props.message.at)}</span>
      </div>
    </>
  );
}

// 圧縮の境目。吹き出しではなく、履歴が切り替わる区切りとして置く。
function CompactionRule() {
  return <span class="hwc-compaction-rule" aria-hidden="true" />;
}

// 要約は開かないと読めない。畳んだ 1 行だけでも、ここより前が圧縮されたことが分かる。
// 所要時間は開始を観測できたときだけ添える。リロード後は tokens とホバー時刻だけになる。
export function Compaction(props: {
  compaction: ChatCompaction;
  expandable: boolean;
  durationMs: number | null;
}) {
  const label = compactionLabel(props.compaction);
  const shown = props.durationMs === null ? label : `${formatElapsed(props.durationMs)} · ${label}`;
  const title = `${formatClock(props.compaction.at)} に圧縮`;
  if (!props.expandable || props.compaction.summary === "") {
    return (
      <p class="hwc-compaction">
        <CompactionRule />
        <span class="hwc-compaction-label" title={title}>
          {shown}
        </span>
        <CompactionRule />
      </p>
    );
  }

  return (
    <details class="hwc-compaction">
      <summary class="hwc-compaction-head">
        <CompactionRule />
        <span class="hwc-compaction-label" title={title}>
          {shown}
        </span>
        <span class="hwc-compaction-icon">
          <ChevronRightIcon size={16} />
        </span>
        <CompactionRule />
      </summary>
      <div class="hwc-compaction-body">{props.compaction.summary}</div>
    </details>
  );
}

// ローカルで送った /compact の控え。セッションには残らないので、リロードや
// ペイン切り替えで消える。完了した compaction の直前、実行中は後から送ったメッセージの前に置く。
export function CommandEcho(props: { text: string; at: number }) {
  return (
    <li class="hwc-msg" data-role="command">
      <div class="hwc-command-echo">{props.text}</div>
      <div class="hwc-msg-meta">
        <span class="hwc-msg-time">{formatClock(props.at)}</span>
      </div>
    </li>
  );
}

// 失敗したターン。吹き出しにはせず、応答が返らなかった記録として置く。
// 本文はプロバイダが返した生の文言なので、Markdown として解釈せずそのまま出す。
export function ErrorMessage(props: { message: ChatMessage; copyButton: ComponentChildren }) {
  const count = props.message.count ?? 1;
  return (
    <>
      <div class="hwc-error">
        <span class="hwc-error-head">
          <StatusMark tone="attention" size={12} />
          応答に失敗しました
          {count > 1 ? <span class="hwc-error-count">{count} 回</span> : null}
        </span>
        <p class="hwc-error-text">{props.message.text}</p>
      </div>
      <div class="hwc-msg-meta">
        <span class="hwc-msg-time">{formatClock(props.message.at)}</span>
        {props.copyButton}
      </div>
    </>
  );
}
