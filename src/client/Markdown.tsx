import { createContext, Fragment, type ComponentChildren } from "preact";
import { useContext, useMemo, useState } from "preact/hooks";
import type { MessageImageSource } from "./chat";
import { useCopy } from "./copy";
import { CopyGlyph } from "./icons";
import { imageOnlyNodes, inlineText, parseInline } from "./markdown/inline";
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "./markdown/parse";
import type { MdBlock, MdImage, MdInline, MdListItem } from "./markdown/types";

const HEADING_TAGS = ["h3", "h4", "h5", "h6"] as const;

type ImageContextValue = {
  images?: ReadonlyMap<string, MessageImageSource>;
  onOpenImage?: (url: string, name: string) => void;
};

// 本文の深さをそのまま関数の引数で渡すと、絵を使わない入れ子のすべてに同じ値を配る
// ことになる。画像記法の描画にだけ要る値なので、本文の解析結果を受ける側でまとめて配る。
const ImageContext = createContext<ImageContextValue>({});

type MdGroup =
  | { kind: "block"; block: MdBlock }
  // 画像記法だけでできた段落は、縦に積まずに横へ並べる（ADR 0055）。
  | { kind: "images"; images: MdImage[] };

// 画像の段落が連続しているときは 1 つの行にまとめる。改行で区切られていても、
// 段落が分かれていても、読み手には同じ「並んだ絵」に見える。
function groupBlocks(blocks: readonly MdBlock[]): MdGroup[] {
  const groups: MdGroup[] = [];
  for (const block of blocks) {
    const images =
      block.kind === "paragraph" && block.source.includes("![")
        ? imageOnlyNodes(parseInline(block.source))
        : null;
    if (images === null) {
      groups.push({ kind: "block", block });
      continue;
    }
    const last = groups.at(-1);
    if (last?.kind === "images") last.images.push(...images);
    else groups.push({ kind: "images", images: [...images] });
  }
  return groups;
}

type TaskCounter = { value: number };

// 本文が上限を超えたら、解析せず原文をそのまま出す。解析してから捨てると固まる。
// ルートの data-quote-scope は、本文の選択から返信を始める範囲を示す。
export function Markdown({
  text,
  taskScope,
  images,
  onOpenImage,
}: {
  text: string;
  taskScope?: string;
  images?: ReadonlyMap<string, MessageImageSource>;
  onOpenImage?: (url: string, name: string) => void;
}) {
  if (text.length > MARKDOWN_MAX_LENGTH) {
    return (
      <div class="hwc-md" data-plain data-quote-scope="true">
        {text}
      </div>
    );
  }
  // タスクの通し番号は Markdown の描画ごとに 0 から数える。メッセージをまたぐ一意性は taskScope が担う。
  const taskCounter = { value: 0 };
  return (
    <ImageContext.Provider value={{ images, onOpenImage }}>
      <div class="hwc-md" data-quote-scope="true">
        <MarkdownBlocks text={text} taskScope={taskScope} taskCounter={taskCounter} />
      </div>
    </ImageContext.Provider>
  );
}

function MarkdownBlocks({
  text,
  depth = 0,
  taskScope,
  taskCounter,
}: {
  text: string;
  depth?: number;
  taskScope?: string;
  taskCounter: TaskCounter;
}) {
  const groups = useMemo(() => groupBlocks(parseMarkdown(text)), [text]);
  return (
    <>
      {groups.map((group, index) =>
        group.kind === "images" ? (
          <ImageRow nodes={group.images} key={index} />
        ) : (
          <Block
            block={group.block}
            depth={depth}
            taskScope={taskScope}
            taskCounter={taskCounter}
            key={index}
          />
        ),
      )}
    </>
  );
}

function ImageRow({ nodes }: { nodes: MdImage[] }) {
  const context = useContext(ImageContext);
  return (
    <div class="hwc-md-image-row">
      {nodes.map((node, index) => (
        <Fragment key={index}>{imageNode(node, context)}</Fragment>
      ))}
    </div>
  );
}

function Block({
  block,
  depth,
  taskScope,
  taskCounter,
}: {
  block: MdBlock;
  depth: number;
  taskScope?: string;
  taskCounter: TaskCounter;
}) {
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
      return <List block={block} depth={depth} taskScope={taskScope} taskCounter={taskCounter} />;
    case "quote":
      return (
        <blockquote>
          <MarkdownBlocks
            text={block.source}
            depth={depth}
            taskScope={taskScope}
            taskCounter={taskCounter}
          />
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

function taskLabel(source: string, fallback: string): string {
  const line = source.split("\n", 1)[0] ?? "";
  return inlineText(parseInline(line)).trim() || fallback;
}

function List({
  block,
  depth,
  taskScope,
  taskCounter,
}: {
  block: Extract<MdBlock, { kind: "list" }>;
  depth: number;
  taskScope?: string;
  taskCounter: TaskCounter;
}) {
  const items = block.items.map((item, index) => (
    <ListItem
      block={block}
      depth={depth}
      index={index}
      item={item}
      key={index}
      taskScope={taskScope}
      taskCounter={taskCounter}
    />
  ));
  return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
}

function ListItem({
  block,
  depth,
  index,
  item,
  taskScope,
  taskCounter,
}: {
  block: Extract<MdBlock, { kind: "list" }>;
  depth: number;
  index: number;
  item: MdListItem;
  taskScope?: string;
  taskCounter: TaskCounter;
}) {
  const fallback =
    item.task === undefined
      ? "タスク"
      : `${taskScope === undefined ? "" : `${taskScope}の`}${++taskCounter.value}番目のタスク`;
  const label = item.task === undefined ? null : taskLabel(item.source, fallback);
  return (
    <li class="hwc-md-li">
      {item.task !== undefined && block.ordered ? (
        <>
          <span class="hwc-md-marker" aria-hidden="true">
            {`${block.start + index}.`}
          </span>
          <TaskCheckbox checked={item.task} label={label ?? fallback} />
        </>
      ) : item.task !== undefined ? (
        <span class="hwc-md-marker">
          <TaskCheckbox checked={item.task} label={label ?? fallback} />
        </span>
      ) : (
        <span class="hwc-md-marker" aria-hidden="true">
          {block.ordered ? `${block.start + index}.` : depth === 0 ? "•" : "◦"}
        </span>
      )}
      <div class="hwc-md-li-body">
        <MarkdownBlocks
          text={item.source}
          depth={depth + 1}
          taskScope={taskScope}
          taskCounter={taskCounter}
        />
      </div>
    </li>
  );
}

function TaskCheckbox({ checked, label }: { checked: boolean; label: string }) {
  const [done, setDone] = useState(checked);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      aria-description="押すと切り替わります。保存されません"
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
  const images = useContext(ImageContext);
  return <>{inlineChildren(nodes, images)}</>;
}

function inlineChildren(nodes: MdInline[], context: ImageContextValue): ComponentChildren[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "literal":
        return <code class="hwc-md-literal">{node.text}</code>;
      case "strong":
        return <strong>{inlineChildren(node.children, context)}</strong>;
      case "em":
        return <em>{inlineChildren(node.children, context)}</em>;
      case "del":
        return <del>{inlineChildren(node.children, context)}</del>;
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
            {inlineChildren(node.children, context)}
          </a>
        );
      case "image":
        return imageNode(node, context);
      case "break":
        return <br />;
    }
  });
}

// 実在を確認したファイルだけを絵にする。決まらない記法は原文のまま残す。
function imageNode(node: MdImage, context: ImageContextValue) {
  const image = context.images?.get(node.href);
  const open = context.onOpenImage;
  if (image === undefined || open === undefined) {
    return <code class="hwc-md-literal">{node.raw}</code>;
  }
  const alt = inlineText(node.children).trim();
  // 読み上げ名は alt を優先する。img は装飾にし、ボタンの名前だけを読ませる
  // （ADR 0042 / ADR 0055）。
  const name = alt === "" ? image.label : alt;
  return (
    <button
      type="button"
      class="hwc-md-image"
      aria-label={`${name} を拡大`}
      aria-haspopup="dialog"
      onClick={() => open(image.url, image.label)}
    >
      <img class="hwc-md-image-content" src={image.url} alt="" loading="lazy" />
    </button>
  );
}
