import type { AppState } from "../server/herdr/state";
import { activePanes } from "./scope";
import { parentPaneOf } from "../shared/parent-pane";
import { statusTone, type StatusTone } from "./select";

export type FaviconStatus = "working" | "blocked" | "done";

const DOT_COLORS: Record<Exclude<StatusTone, "neutral">, string> = {
  active: "#f5c542",
  attention: "#e5484d",
  success: "#4cc9f0",
};

// 完了はスペースの親だけで見る。子の done を混ぜると、impl だけ終わった段階で
// スペース全体が完了に見える。赤と黄は子も含める。子の質問や作業は拾う必要がある。
export function faviconStatus(state: AppState): FaviconStatus | null {
  let working = false;
  for (const { pane } of activePanes(state)) {
    if (pane.agentStatus === "blocked") return "blocked";
    if (pane.agentStatus === "working") working = true;
  }
  if (state.workspaces.some((workspace) => parentPaneOf(workspace)?.agentStatus === "done")) {
    return "done";
  }
  return working ? "working" : null;
}

// viewBox の外側に 1 単位の透明な余白を取る。Windows Chrome の 125% 表示で、
// 端の画素が反対側へにじむのを防ぐ。図形は 0..24 に収める。
export function faviconSvg(status: FaviconStatus): string {
  const tone = statusTone(status);
  const fill = tone === "neutral" ? null : DOT_COLORS[tone];
  const dot =
    fill === null
      ? ""
      : `<circle cx="18.5" cy="18.5" r="4" fill="${fill}" stroke="#18212f" stroke-width="1.5" />`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 26 26">',
    '<rect width="24" height="24" rx="6" fill="#18212f" />',
    '<g fill="#f2f4f7">',
    '<rect x="3" y="3" width="8" height="8" rx="2.5" />',
    '<rect x="13" y="3" width="8" height="8" rx="2.5" />',
    '<rect x="3" y="13" width="8" height="8" rx="2.5" />',
    '<rect x="13" y="13" width="8" height="8" rx="2.5" opacity="0.45" />',
    "</g>",
    dot,
    "</svg>",
  ].join("");
}

export function faviconHref(status: FaviconStatus | null, baseHref: string): string {
  if (status === null) return baseHref;
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(status))}`;
}

// SVG favicon を持たないブラウザ（Safari 26 未満、iOS の Chrome）のアイコンは、HTML に
// 置いた PNG が担う。消すとそのブラウザではアイコンが 1 枚も無くなる。Chrome は PNG が
// 残っていても SVG の href の差し替えを反映するので、点の更新は妨げられない。
export function applyFavicon(status: FaviconStatus | null): void {
  const svg = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (svg === null) return;
  // Bun は HTML のアイコンをハッシュ付きの URL に書き換える。ソースのパスを自分で
  // 組み立てず、最初の href を控えて点なしへ戻すときにも使う。
  const baseHref = svg.dataset.baseHref ?? svg.getAttribute("href") ?? "";
  if (svg.dataset.baseHref === undefined) svg.dataset.baseHref = baseHref;
  const href = faviconHref(status, baseHref);
  // 同じ値で書き直すと、ブラウザがアイコンの取得をやり直してタブに出るまでが遅れる。
  // 状態が変わったときだけ触る。
  if (svg.getAttribute("href") !== href) svg.href = href;
}
