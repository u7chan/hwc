// 選択した本文を、描画に使った Markdown の記法ごとクリップボードへ戻す。
// 元の Markdown は持っていないので、描画した DOM のタグ・クラス・data 属性から組み立てる。
// ブロックの一部だけを選んだときは、そのブロックの印（見出し・項目・フェンス）を付けない。

const CONTENT_ROOT_SELECTOR =
  ".hwc-md, .hwc-msg-body, .hwc-output, .hwc-error-text, .hwc-command-echo, .hwc-compaction-body";

const SKIP_SELECTOR = [
  ".hwc-md-copy",
  ".hwc-md-lang",
  ".hwc-md-marker",
  ".hwc-md-task",
  ".hwc-msg-more",
  ".hwc-msg-time",
].join(", ");

export function selectionCopyText(scroller: HTMLElement, range: Range): string {
  const roots = [...scroller.querySelectorAll(CONTENT_ROOT_SELECTOR)].filter(
    (root) => root instanceof HTMLElement && intersects(root, range),
  );
  if (roots.length === 0) return range.toString();

  const parts = roots
    .map((root) =>
      root.matches(".hwc-md") && !root.hasAttribute("data-plain")
        ? serializeMarkdown(root, range)
        : textWithin(root, range),
    )
    .map(trimNewlines)
    .filter((part) => part !== "");
  return parts.join("\n\n");
}

export function fenceFor(text: string): string {
  let size = 3;
  for (const line of text.split("\n")) {
    const match = /^\s*(`{3,})/.exec(line);
    if (match !== null) size = Math.max(size, match[1].length + 1);
  }
  return "`".repeat(size);
}

export function inlineCode(text: string): string {
  if (text === "") return "";
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

export function markdownLink(label: string, href: string, title: string | null): string {
  if (href === "") return label;
  const target =
    title === null || title === "" ? href : `${href} "${title.replaceAll('"', '\\"')}"`;
  return `[${label}](${target})`;
}

export function listMarker(ordered: boolean, number: number, task: boolean | null): string {
  if (task !== null) return `${ordered ? `${number}.` : "-"} [${task ? "x" : " "}] `;
  return ordered ? `${number}. ` : "- ";
}

function serializeMarkdown(root: Element, range: Range): string {
  return trimNewlines(serializeChildren(root, range, 0));
}

function serializeChildren(parent: Node, range: Range, depth: number): string {
  let out = "";
  for (const child of parent.childNodes) {
    if (!intersects(child, range)) continue;
    out += serializeNode(child, range, depth);
  }
  return out;
}

function serializeNode(node: Node, range: Range, depth: number): string {
  if (node.nodeType === Node.TEXT_NODE) return selectedText(node as Text, range);
  if (!(node instanceof Element)) return "";
  if (!intersects(node, range)) return "";
  if (node.matches(SKIP_SELECTOR)) return "";
  if (node.matches("button.hwc-md-image")) return imageMarkdown(node);
  if (node.matches("button, svg, input, script, style")) return "";
  if (node.matches(".hwc-md-figure")) return serializeFigure(node, range, depth);
  if (node.matches(".hwc-md-table-wrap")) {
    const table = node.querySelector("table");
    return table === null
      ? serializeChildren(node, range, depth)
      : serializeTable(table, range, depth);
  }

  switch (node.tagName) {
    case "BR":
      return "\n";
    case "HR":
      return "---\n\n";
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return serializeHeading(node, range, depth);
    case "P":
      return `${trimNewlines(serializeChildren(node, range, depth))}\n\n`;
    case "STRONG":
    case "B":
      return wrapInline("**", node, range, depth);
    case "EM":
    case "I":
      return wrapInline("*", node, range, depth);
    case "DEL":
    case "S":
      return wrapInline("~~", node, range, depth);
    case "CODE": {
      if (node.closest("pre") !== null || node.classList.contains("hwc-md-literal")) {
        return serializeChildren(node, range, depth);
      }
      return inlineCode(serializeChildren(node, range, depth));
    }
    case "PRE":
      return serializeCodeBlock(node, range);
    case "BLOCKQUOTE":
      return serializeQuote(node, range, depth);
    case "UL":
    case "OL":
      return serializeList(node, range, depth);
    case "TABLE":
      return serializeTable(node, range, depth);
    case "A":
      return serializeLink(node, range, depth);
    case "IMG": {
      const alt = node.getAttribute("alt") ?? "";
      return alt;
    }
    default:
      return serializeChildren(node, range, depth);
  }
}

function serializeHeading(node: Element, range: Range, depth: number): string {
  const inner = trimNewlines(serializeChildren(node, range, depth));
  if (inner === "") return "";
  const level =
    node.tagName === "H3" ? 1 : node.tagName === "H4" ? 2 : node.tagName === "H5" ? 3 : 4;
  const marker = coversContents(range, node) ? `${"#".repeat(level)} ` : "";
  return `${marker}${inner}\n\n`;
}

function wrapInline(marker: string, node: Element, range: Range, depth: number): string {
  const inner = serializeChildren(node, range, depth);
  return inner === "" ? "" : `${marker}${inner}${marker}`;
}

function serializeLink(node: Element, range: Range, depth: number): string {
  const label = serializeChildren(node, range, depth);
  if (label === "") return "";
  return markdownLink(label, node.getAttribute("href") ?? "", node.getAttribute("title"));
}

function serializeFigure(node: Element, range: Range, depth: number): string {
  const pre = node.querySelector("pre");
  return pre === null ? serializeChildren(node, range, depth) : serializeCodeBlock(pre, range);
}

function serializeCodeBlock(pre: Element, range: Range): string {
  const code = pre.querySelector("code") ?? pre;
  if (!intersects(code, range)) return "";
  const text = textWithin(code, range);
  if (!coversContents(range, code) && !coversContents(range, pre)) return text;
  const figure = pre.closest(".hwc-md-figure");
  const lang = figure?.querySelector(".hwc-md-lang")?.textContent?.trim() ?? "";
  const fence = fenceFor(text);
  return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
}

function serializeQuote(node: Element, range: Range, depth: number): string {
  const inner = trimNewlines(serializeChildren(node, range, depth));
  if (inner === "") return "";
  if (!coversContents(range, node)) return `${inner}\n\n`;
  const quoted = inner
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  return `${quoted}\n\n`;
}

function serializeList(node: Element, range: Range, depth: number): string {
  const ordered = node.tagName === "OL";
  const start = ordered ? Number(node.getAttribute("start") ?? "1") : 1;
  // 番号は選択に含まれる項目だけで数え直さない。先頭の項目を選ばなくても、
  // 画面に出ている番号（start + 元の並び順）をそのまま使う。
  const items = [...node.children].filter((child) => child.tagName === "LI");
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  const continuation = "  ".repeat(depth + 1);

  for (const [index, item] of items.entries()) {
    if (!intersects(item, range)) continue;
    const taskButton = item.querySelector(
      ":scope > .hwc-md-task, :scope > .hwc-md-marker .hwc-md-task",
    );
    const task = taskButton === null ? null : taskButton.getAttribute("aria-checked") === "true";
    const marker = coversContents(range, item) ? listMarker(ordered, start + index, task) : "";
    const body = trimNewlines(serializeListItemBody(item, range, depth));
    const bodyLines = body.split("\n");
    if (bodyLines.length === 0 || (bodyLines.length === 1 && bodyLines[0] === "")) continue;

    lines.push(`${indent}${marker}${bodyLines[0]}`);
    for (const line of bodyLines.slice(1)) {
      if (line === "") lines.push("");
      else if (line.startsWith(continuation)) lines.push(line);
      else lines.push(`${continuation}${line}`);
    }
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}

function serializeListItemBody(item: Element, range: Range, depth: number): string {
  const body = item.querySelector(":scope > .hwc-md-li-body");
  if (body !== null) return serializeChildren(body, range, depth + 1);
  let out = "";
  for (const child of item.childNodes) {
    if (child instanceof Element && child.matches(".hwc-md-marker, .hwc-md-task")) continue;
    if (!intersects(child, range)) continue;
    out += serializeNode(child, range, depth + 1);
  }
  return out;
}

function serializeTable(table: Element, range: Range, depth: number): string {
  if (!coversContents(range, table)) return textWithin(table, range);
  const headers = [...table.querySelectorAll("thead th")];
  if (headers.length === 0) return textWithin(table, range);

  const cellText = (cell: Element) =>
    serializeChildren(cell, range, depth).replace(/\n+/g, " ").trim().replaceAll("|", "\\|");
  const aligns = headers.map((cell) => {
    const align = cell.getAttribute("data-align");
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    if (align === "left") return ":---";
    return "---";
  });
  const lines = [`| ${headers.map(cellText).join(" | ")} |`, `| ${aligns.join(" | ")} |`];
  for (const row of table.querySelectorAll("tbody tr")) {
    const cells = [...row.querySelectorAll("td")];
    if (cells.length === 0) continue;
    lines.push(`| ${cells.map(cellText).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n\n`;
}

function imageMarkdown(button: Element): string {
  const raw = button.getAttribute("data-md-raw");
  if (raw !== null) return raw;
  return (button.getAttribute("aria-label") ?? "").replace(/ を拡大$/, "");
}

function selectedText(node: Text, range: Range): string {
  const start = node === range.startContainer ? range.startOffset : 0;
  const end = node === range.endContainer ? range.endOffset : node.data.length;
  return start < end ? node.data.slice(start, end) : "";
}

function intersects(node: Node, range: Range): boolean {
  if (!node.isConnected) return false;
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

// ブロックの文字がすべて選ばれているかを見る。要素の境界ではなく、中身の
// 非空白文字で比べる。ドラッグは要素の先頭・末尾ちょうどではなく、最初と最後の
// 文字で始まる・終わることが多く、境界だけで比べると全体選択を取りこぼす。
// 項目の印・コードの言語名・コピーボタンはブロックの中身ではないので除く。
function coversContents(range: Range, element: Element): boolean {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let found = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text) || insideSkipped(node, element)) continue;
    const text = node.data;
    let start = 0;
    while (start < text.length && /\s/.test(text[start]!)) start += 1;
    let end = text.length;
    while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
    if (start === end) continue;
    found = true;
    const content = document.createRange();
    content.setStart(node, start);
    content.setEnd(node, end);
    try {
      if (
        range.compareBoundaryPoints(Range.START_TO_START, content) > 0 ||
        range.compareBoundaryPoints(Range.END_TO_END, content) < 0
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return found;
}

function insideSkipped(node: Text, root: Element): boolean {
  const skipped = node.parentElement?.closest(SKIP_SELECTOR) ?? null;
  return skipped !== null && root.contains(skipped);
}

// ルートの外へはみ出した選択を、そのルートの中だけに切り詰める。
function textWithin(root: Element, range: Range): string {
  if (!intersects(root, range)) return "";
  const inner = document.createRange();
  inner.selectNodeContents(root);
  const start = range.compareBoundaryPoints(Range.START_TO_START, inner) > 0 ? range : inner;
  const end = range.compareBoundaryPoints(Range.END_TO_END, inner) < 0 ? range : inner;
  const clamped = document.createRange();
  clamped.setStart(start.startContainer, start.startOffset);
  clamped.setEnd(end.endContainer, end.endOffset);
  return clamped.toString();
}

function trimNewlines(text: string): string {
  return text.replace(/^\n+|\n+$/g, "");
}
