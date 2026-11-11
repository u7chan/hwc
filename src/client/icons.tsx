import { agentGlyph } from "./select";

type IconProps = { size?: number };

function Svg(props: { size: number; class?: string; children: preact.ComponentChildren }) {
  return (
    <svg
      class={props.class}
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export function ChevronLeftIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

export function ChevronRightIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

// メニューを開く印。開閉のシェブロンと違い、下向きのまま使う。
export function ChevronDownIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 9l7 7 7-7" />
    </Svg>
  );
}

// 開閉のシェブロンと形を分けるための、軸のある矢印。行の移動にだけ使う。
export function ArrowRightIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 12h13" />
      <path d="M12.5 6.5L19 12l-6.5 5.5" />
    </Svg>
  );
}

export function WorkspaceIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 9h18" />
    </Svg>
  );
}

// git 管理下のワークスペース。枝分かれの形で表す。
export function RepoIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="7" cy="6" r="2.4" />
      <circle cx="7" cy="18" r="2.4" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M7 8.4v7.2" />
      <path d="M17 11.4v.6a4 4 0 0 1-4 4H9.4" />
    </Svg>
  );
}

// 追加のチェックアウト（linked worktree）は、枝の隣に別の面を添えて示す。
export function WorktreeIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <path d="M6 8.2v7.6" />
      <path d="M6 11h3.5a3 3 0 0 0 3-3V7.4" />
      <circle cx="12.5" cy="5.2" r="1.8" />
      <rect x="13.5" y="13" width="7" height="7" rx="1.8" />
    </Svg>
  );
}

// リモートの情報を取ってくる。下向きの矢印だけだと取り込みと区別できないので、
// 雲から降ろす形にする。
export function FetchIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7 17a4 4 0 0 1-.7-7.9A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 7" />
      <path d="M12 12v8" />
      <path d="M8.5 16.5L12 20l3.5-3.5" />
    </Svg>
  );
}

// 上流の変更を今のブランチへ取り込む。下向きの矢印を線の上に置く。
export function PullIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 4v10" />
      <path d="M8 10l4 4 4-4" />
      <path d="M5 20h14" />
    </Svg>
  );
}

// マージ済みの PR。左の 2 つの点を束ねる枝で、開いている PR の番号だけのチップと形で区別する。
export function MergeIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="7" cy="5.5" r="2.2" />
      <circle cx="7" cy="18.5" r="2.2" />
      <circle cx="17" cy="12" r="2.4" />
      <path d="M7 7.7v8.6" />
      <path d="M9.2 9.2c1.6 3 3.3 2.8 5.4 2.8" />
    </Svg>
  );
}

export function MoreIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="5.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

// 6 点のグリップ。並べ替えで持ち上げていることを示す。
export function GripIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

export function ImageIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M21 15l-5-5L7 20" />
    </Svg>
  );
}

// 新しい会話。同じペインで会話だけを作り直すが、円を描き直す矢印は更新に見えるので、会話の吹き出しに + を添える。
export function NewSessionIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="13" rx="3" />
      <path d="M7.5 17v3.5L12 17" />
      <path d="M12 7.5v6" />
      <path d="M9 10.5h6" />
    </Svg>
  );
}

export function ReplyIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9 17l-5-5 5-5" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </Svg>
  );
}

export function CopyIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 6.5A2.5 2.5 0 0 0 12.5 4h-7A2.5 2.5 0 0 0 3 6.5v7A2.5 2.5 0 0 0 5.5 16" />
    </Svg>
  );
}

export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}

// コピーの結果を記号で返す。入れ替わりが分かるように重ねておく。
export function CopyGlyph({ copied, size = 16 }: IconProps & { copied: boolean }) {
  return (
    <span
      class="hwc-copy-glyph"
      data-copied={copied}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      <span class="hwc-copy-glyph-layer hwc-copy-glyph-copy">
        <CopyIcon size={size} />
      </span>
      <span class="hwc-copy-glyph-layer hwc-copy-glyph-check">
        <CheckIcon size={size} />
      </span>
    </span>
  );
}

export function TabIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 7h6l2 3h8" />
      <path d="M4 7v10a2 2 0 002 2h12a2 2 0 002-2V10" />
    </Svg>
  );
}

// スペースの親ペイン。左端にいる作業の起点を、状態記号とは別の形で示す。
export function ParentIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 17.5l-1.2-9 5.2 3.6L12 5.5l4 6.6 5.2-3.6-1.2 9z" />
      <path d="M5.5 20.5h13" />
    </Svg>
  );
}

// エージェントの見分けは、公式マークの形で付ける（色は行の色に合わせる）。
export function PiIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 800 800" fill="currentColor" aria-hidden="true">
      <path
        fill-rule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

export function ClaudeIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
      <path d="m100.5 340.4 100.7-56.5 1.7-4.9-1.7-2.7h-4.9l-16.9-1-57.6-1.6-49.8-2.1-48.4-2.6-12.2-2.6-11.4-15 1.2-7.5 10.2-6.8 14.6 1.3 32.4 2.2L107 244l35.2 2.1 52.2 5.4h8.3l1.2-3.3-2.9-2.1-2.2-2.1-50.3-34-54.4-36-28.5-20.7-15.4-10.5-7.8-9.9-3.4-21.5L53 96l18.8 1.3 4.8 1.3 19.1 14.6 40.7 31.5 53.1 39.1 7.8 6.5 3.1-2.2.4-1.6-3.5-5.8-28.9-52.2-30.8-53.1-13.7-22-3.6-13.4c-1.4-5.1-2.1-10.3-2.2-15.6l16-21.6 8.8-2.9 21.2 2.9 9 7.8 13.2 30.2 21.4 47.6 33.2 64.6 9.7 19.2 5.2 17.7 1.9 5.4h3.4v-3.1l2.7-36.4 5.1-44.7 4.9-57.5 1.7-16.2 8-19.4 15.9-10.5 12.5 6 10.2 14.6-1.4 9.5-6.1 39.5-11.9 61.9-7.8 41.4h4.5l5.2-5.2 21-27.9 35.2-44 15.6-17.5 18.1-19.3 11.7-9.2h22l16.2 24.1-7.3 24.9-22.7 28.7-18.8 24.4-27 36.3-16.9 29 1.6 2.3 4-.4 60.9-12.9 32.9-6 39.3-6.7 17.8 8.3 1.9 8.4-7 17.2-42 10.4-49.3 9.9-73.4 17.3-.9.6 1 1.3 33 3.1 14.1.8h34.6l64.4 4.8 16.9 11.1 10.1 13.6-1.7 10.3-25.9 13.2-35-8.3-81.7-19.4-28-7h-3.9v2.3l23.3 22.8 42.8 38.6L455 410l2.7 12.3-6.9 9.7-7.3-1-47-35.3-18.2-15.9-41.1-34.6h-2.7v3.6l9.5 13.8 50 75.1 2.6 23-3.6 7.5-13 4.5-14.3-2.6-28.7-40.7-30.2-46.2-24.4-41.5-3 1.7L265 498.2l-6.7 7.9-15.6 6-12.9-9.8-6.9-15.9 6.9-31.5 8.3-41 6.7-32.6 6.1-40.5 3.6-13.5-.3-.9-3 .4-30.6 42-46.5 62.8-36.8 39.4-8.8 3.5-15.3-7.9 1.4-14.1 8.6-12.6 50.9-64.8 30.7-40.1 19.8-23.2-.1-3.4h-1.2L88.1 395.9 64 399.1l-10.4-9.7 1.3-15.9 4.9-5.2 40.7-28c.1-.1 0 .1 0 .1" />
    </svg>
  );
}

export function CodexIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.355-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872m16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.603-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

export function OpenCodeIcon({ size = 18 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fill-rule="evenodd"
      aria-hidden="true"
    >
      <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
    </svg>
  );
}

export function AgentIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M11 3.5l1.9 4.9 4.9 1.9-4.9 1.9L11 17l-1.9-4.8L4.2 10.3l4.9-1.9z" />
      <path d="M18 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </Svg>
  );
}

export function AgentGlyphIcon({ agent, size = 18 }: { agent: string | null; size?: number }) {
  switch (agentGlyph(agent)) {
    case "pi":
      return <PiIcon size={size} />;
    case "claude":
      return <ClaudeIcon size={size} />;
    case "codex":
      return <CodexIcon size={size} />;
    case "opencode":
      return <OpenCodeIcon size={size} />;
    default:
      return <AgentIcon size={size} />;
  }
}

export function TerminalIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M7.5 10l2.5 2-2.5 2" />
      <path d="M13 14h3.5" />
    </Svg>
  );
}

export function PaneIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M7 10l2.5 2L7 14" />
      <path d="M12.5 14.5h4" />
    </Svg>
  );
}

export function SendIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 19V6" />
      <path d="M6 11.5L12 5.5l6 6" />
    </Svg>
  );
}

// 実行中のターンを止める。塗りつぶした四角で、送信の矢印と形を分ける。
export function StopIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size} class="hwc-stop-icon">
      <rect x="2" y="2" width="20" height="20" rx="3.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

// プレビューのタブ。
export function EyeIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3.2" />
    </Svg>
  );
}

export function ArrowDownIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 5v14" />
      <path d="M6 13l6 6 6-6" />
    </Svg>
  );
}

export function CloseIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  );
}

// 画面とスクロールバックを消す。削除ではないので、ゴミ箱ではなく消しゴムで表す。
export function EraserIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </Svg>
  );
}

// チェックアウトの削除。閉じる（×）とは戻せなさが違うので、ゴミ箱で区別する。
export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 7h16" />
      <path d="M9.5 4h5l.5 3h-6z" />
      <path d="M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Svg>
  );
}

export function HwcMark({ size = 24 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="8" height="8" rx="2.5" />
      <rect x="13" y="3" width="8" height="8" rx="2.5" />
      <rect x="3" y="13" width="8" height="8" rx="2.5" />
      <rect x="13" y="13" width="8" height="8" rx="2.5" opacity="0.45" />
    </svg>
  );
}

export function SettingsIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M10.43 5.18 L10.63 2.8 L13.37 2.8 L13.57 5.18 L15.71 6.06 L17.53 4.52 L19.48 6.47 L17.94 8.29 L18.82 10.43 L21.2 10.63 L21.2 13.37 L18.82 13.57 L17.94 15.71 L19.48 17.53 L17.53 19.48 L15.71 17.94 L13.57 18.82 L13.37 21.2 L10.63 21.2 L10.43 18.82 L8.29 17.94 L6.47 19.48 L4.52 17.53 L6.06 15.71 L5.18 13.57 L2.8 13.37 L2.8 10.63 L5.18 10.43 L6.06 8.29 L4.52 6.47 L6.47 4.52 L8.29 6.06 Z" />
      <circle cx="12" cy="12" r="3.2" />
    </Svg>
  );
}

export function ExpandIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-7 7" />
      <path d="M10 20H4v-6" />
      <path d="M4 20l7-7" />
    </Svg>
  );
}

export function CollapseIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 10h-6V4" />
      <path d="M14 10l7-7" />
      <path d="M4 14h6v6" />
      <path d="M10 14l-7 7" />
    </Svg>
  );
}

// 同じ内容を読み直す。プレビューの再読み込みにだけ使う。
export function ReloadIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.5-5.6" />
      <path d="M19.5 4v4.5H15" />
    </Svg>
  );
}

// アプリの外（新しいタブ）へ渡す。
export function ExternalIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M13.5 4H20v6.5" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5" />
    </Svg>
  );
}

// 行き先が GitHub だと分かるようにする。線画のアイコンに混ぜるので、ここだけ塗りで描く。
export function GitHubIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// 本家のマークをそのまま塗りで持つ。外部 CDN を読むと、オフラインや LAN 内で
// マークだけ欠ける。色はブランド色の CSS 変数に任せ、ここでは currentColor にする。
export function DiscordIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.011c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.01c.12.099.246.198.373.292a.077.077 0 0 1-.007.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.04.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.419 0 1.334-.956 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.419 0 1.334-.946 2.419-2.157 2.419z" />
    </svg>
  );
}

export function StatusMark({ tone, size = 16 }: { tone: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {tone === "active" && (
        <path d="M6 1.5a4.5 4.5 0 014.5 4.5A4.5 4.5 0 016 10.5V1.5z" fill="currentColor" />
      )}
      {tone === "active" && <circle cx="6" cy="6" r="4.5" />}
      {tone === "attention" && <path d="M6 1.5L10.5 6 6 10.5 1.5 6z" />}
      {tone === "success" && <path d="M2 6.5l2.5 2.5L10 3.5" />}
      {tone === "neutral" && <circle cx="6" cy="6" r="4" />}
    </svg>
  );
}
