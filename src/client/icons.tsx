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

export function TabIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 7h6l2 3h8" />
      <path d="M4 7v10a2 2 0 002 2h12a2 2 0 002-2V10" />
    </Svg>
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
