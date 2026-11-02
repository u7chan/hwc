import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";
import { parseInline } from "./markdown/inline";
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "./markdown/parse";
import type { MdBlock, MdInline, MdListItem } from "./markdown/types";

const HEADING_TAGS = ["h3", "h4", "h5", "h6"] as const;

// 本文が上限を超えたら、解析せず原文をそのまま出す。解析してから捨てると固まる。
export function Markdown({ text }: { text: string }) {
  if (text.length > MARKDOWN_MAX_LENGTH) {
    return (
      <div class="hwc-md" data-plain>
        {text}
      </div>
    );
  }
  return (
    <div class="hwc-md">
      <MarkdownBlocks text={text} />
    </div>
  );
}

function MarkdownBlocks({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <>
      {blocks.map((block, index) => (
        <Block block={block} key={index} />
      ))}
    </>
  );
}

function Block({ block }: { block: MdBlock }) {
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
      return block.ordered ? (
        <ol start={block.start}>
          <ListItems items={block.items} />
        </ol>
      ) : (
        <ul>
          <ListItems items={block.items} />
        </ul>
      );
    case "quote":
      return (
        <blockquote>
          <MarkdownBlocks text={block.source} />
        </blockquote>
      );
    case "code":
      return (
        <div class="hwc-md-figure">
          {block.lang === null ? null : <span class="hwc-md-lang">{block.lang}</span>}
          <pre class="hwc-md-pre">
            <code>{block.text}</code>
          </pre>
        </div>
      );
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

function ListItems({ items }: { items: MdListItem[] }) {
  return (
    <>
      {items.map((item, index) => (
        <li key={index}>
          <MarkdownBlocks text={item.source} />
        </li>
      ))}
    </>
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
