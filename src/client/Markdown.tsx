import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { useCopy } from "./copy";
import { CopyGlyph } from "./icons";
import { parseInline } from "./markdown/inline";
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "./markdown/parse";
import type { MdBlock, MdInline } from "./markdown/types";

const HEADING_TAGS = ["h3", "h4", "h5", "h6"] as const;

// 本文が上限を超えたら、解析せず原文をそのまま出す。解析してから捨てると固まる。
// ルートの data-quote-scope は、本文の選択から返信を始める範囲を示す。
export function Markdown({ text }: { text: string }) {
  if (text.length > MARKDOWN_MAX_LENGTH) {
    return (
      <div class="hwc-md" data-plain data-quote-scope="true">
        {text}
      </div>
    );
  }
  return (
    <div class="hwc-md" data-quote-scope="true">
      <MarkdownBlocks text={text} />
    </div>
  );
}

function MarkdownBlocks({ text, depth = 0 }: { text: string; depth?: number }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <>
      {blocks.map((block, index) => (
        <Block block={block} depth={depth} key={index} />
      ))}
    </>
  );
}

function Block({ block, depth }: { block: MdBlock; depth: number }) {
  switch (block.kind) {
    case "heading": {
      const Heading = HEADING_TAGS[Math.min(block.level, 4) - 1];
      return (
        <Heading>
          <InlineSource source={block.source} />
        </Heading>
      );
    }
    case "paragraph":
      return (
        <p>
          <InlineSource source={block.source} />
        </p>
      );
    case "list":
      return <List block={block} depth={depth} />;
    case "quote":
      return (
        <blockquote>
          <MarkdownBlocks text={block.source} depth={depth} />
        </blockquote>
      );
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />;
    case "table":
      return (
        <div class="hwc-md-table-wrap">
          <table class="hwc-md-table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th data-align={block.align[index]} key={index}>
                    <InlineSource source={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td data-align={block.align[index]} key={index}>
                      <InlineSource source={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr />;
  }
}

function List({ block, depth }: { block: Extract<MdBlock, { kind: "list" }>; depth: number }) {
  const items = block.items.map((item, index) => (
    <li class="hwc-md-li" key={index}>
      {item.task === undefined ? (
        <span class="hwc-md-marker" aria-hidden="true">
          {block.ordered ? `${block.start + index}.` : depth === 0 ? "•" : "◦"}
        </span>
      ) : (
        <span class="hwc-md-marker">
          <TaskCheckbox checked={item.task} />
        </span>
      )}
      <div class="hwc-md-li-body">
        <MarkdownBlocks text={item.source} depth={depth + 1} />
      </div>
    </li>
  ));
  return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
}

function TaskCheckbox({ checked }: { checked: boolean }) {
  const [done, setDone] = useState(checked);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      title="押して切り替える（残さないので、開き直すと戻る）"
      class="hwc-md-task"
      onClick={() => setDone(!done)}
    >
      <span class="hwc-md-task-box" data-checked={done}>
        {done ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
            <polyline
              points="3,8.5 6.5,12 13,4.5"
              stroke-width="2.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        ) : null}
      </span>
    </button>
  );
}

function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
  const { copiedId, copy } = useCopy();
  const copied = copiedId === "code";
  return (
    <div class="hwc-md-figure">
      {lang === null ? null : <span class="hwc-md-lang">{lang}</span>}
      <div class="hwc-md-code">
        <pre class="hwc-md-pre">
          <code>{text}</code>
        </pre>
        <button
          type="button"
          class="hwc-md-copy"
          data-copied={copied}
          aria-label={copied ? "コピーしました" : "コードをコピー"}
          title={copied ? "コピーしました" : "コピー"}
          onClick={() => copy("code", text)}
        >
          <CopyGlyph copied={copied} size={14} />
        </button>
      </div>
    </div>
  );
}

function InlineSource({ source }: { source: string }) {
  const nodes = useMemo(() => parseInline(source), [source]);
  return <>{inlineChildren(nodes)}</>;
}

function inlineChildren(nodes: MdInline[]): ComponentChildren[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "literal":
        return <code class="hwc-md-literal">{node.text}</code>;
      case "strong":
        return <strong>{inlineChildren(node.children)}</strong>;
      case "em":
        return <em>{inlineChildren(node.children)}</em>;
      case "del":
        return <del>{inlineChildren(node.children)}</del>;
      case "code":
        return <code>{node.text}</code>;
      case "link":
        return (
          <a
            href={node.href}
            title={node.title ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            {inlineChildren(node.children)}
          </a>
        );
      case "break":
        return <br />;
    }
  });
}
