import { agentGlyph } from "./select";

type IconProps = { size?: number };

function Svg(props: { size: number; children: preact.ComponentChildren }) {
  return (
    <svg
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

export function ChevronUpIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 14.5l6-6 6 6" />
    </Svg>
  );
}

export function ChevronDownIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 9l7 7 7-7" />
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

export function MoreIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="5.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.6" fill="currentColor" stroke="none" />
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

export function ArrowDownIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 5v14" />
      <path d="M6 13l6 6 6-6" />
    </Svg>
  );
}

export function PaperclipIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20.4 8.8l-7.9 7.9a3.6 3.6 0 0 1-5.1-5.1l8-8a2.4 2.4 0 0 1 3.4 3.4l-7.9 7.9a1.2 1.2 0 0 1-1.7-1.7l6.9-6.9" />
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

export function HerdrMark({ size = 24 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <g transform="translate(-4.6233 22.0591) scale(0.00539518 -0.00539518)">
        <path d="M2794 3710 c-129 -33 -299 -135 -359 -214 -21 -28 -26 -42 -21 -63 9 -38 154 -178 199 -192 32 -11 41 -9 104 23 171 86 354 70 475 -43 150 -138 150 -379 0 -511 -107 -95 -278 -94 -386 2 l-46 40 -11 -29 c-16 -40 -14 -122 4 -164 60 -144 264 -222 452 -174 360 92 559 494 430 868 -36 103 -81 173 -175 267 -71 72 -100 93 -180 132 -52 26 -127 54 -167 62 -96 21 -230 20 -319 -4z M2183 3695 c-116 -32 -221 -108 -273 -199 -17 -28 -30 -54 -30 -58 0 -4 20 1 45 12 66 28 220 68 294 76 64 7 65 7 137 83 40 41 71 77 69 79 -2 2 -21 8 -42 13 -55 12 -140 10 -200 -6z M2212 3388 c-159 -22 -390 -122 -559 -241 -299 -210 -585 -600 -609 -828 -12 -118 40 -251 125 -318 96 -76 178 -98 426 -116 110 -8 224 -21 254 -29 125 -34 230 -115 272 -211 11 -24 24 -81 30 -127 20 -170 65 -271 166 -374 34 -35 63 -65 63 -67 0 -1 -10 -27 -22 -57 -29 -76 -37 -259 -14 -350 42 -170 158 -318 311 -397 44 -23 98 -46 120 -52 22 -6 45 -14 51 -18 5 -5 15 -48 22 -96 6 -48 14 -92 17 -97 4 -6 415 -10 1131 -10 l1124 0 0 1584 0 1585 -55 -19 c-84 -29 -143 -68 -232 -154 l-83 -78 -54 49 c-111 102 -233 151 -391 160 -113 6 -199 -10 -298 -54 l-60 -27 -26 34 c-37 51 -120 134 -127 128 -3 -4 0 -34 7 -67 17 -89 7 -268 -21 -356 -103 -328 -377 -545 -688 -545 -161 0 -273 41 -373 137 -37 35 -66 75 -85 116 -79 173 -8 407 124 407 44 0 68 -14 117 -66 74 -78 167 -82 238 -9 60 62 72 147 33 231 -42 90 -120 130 -238 122 -50 -4 -85 -14 -131 -37 -89 -45 -122 -52 -176 -40 -92 20 -262 163 -302 253 -11 25 -21 45 -22 45 -1 -1 -30 -6 -65 -11z m-256 -505 c115 -88 129 -102 132 -131 2 -18 -2 -40 -9 -49 -7 -8 -69 -55 -138 -105 -103 -73 -130 -88 -151 -83 -35 8 -51 34 -48 74 3 31 12 42 83 92 44 31 80 61 82 66 1 4 -30 31 -69 58 -39 28 -77 56 -85 63 -18 19 -16 72 4 94 32 35 63 23 199 -79z m528 -88 c23 -24 28 -52 14 -82 l-13 -28 -141 -3 c-130 -2 -142 -1 -158 17 -23 26 -24 66 -1 91 16 18 32 20 151 20 105 0 136 -3 148 -15z" />
      </g>
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
