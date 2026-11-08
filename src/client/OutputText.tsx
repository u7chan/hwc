import { Fragment } from "preact";
import type { CSSProperties } from "preact";
import { useMemo } from "preact/hooks";
import { parseAnsi, type AnsiStyle } from "./ansi";
import { linkify } from "./links";

function css(style: AnsiStyle): CSSProperties {
  const result: CSSProperties = {};
  if (style.fg !== null) {
    result.color =
      style.fg.kind === "basic"
        ? `var(--ansi-${style.fg.index})`
        : `rgb(${style.fg.r} ${style.fg.g} ${style.fg.b})`;
  }
  if (style.bold) result.fontWeight = 700;
  if (style.dim) result.opacity = 0.65;
  if (style.italic) result.fontStyle = "italic";

  const decorations: string[] = [];
  if (style.underline) decorations.push("underline");
  if (style.strike) decorations.push("line-through");
  if (decorations.length > 0) result.textDecoration = decorations.join(" ");

  return result;
}

function unstyled(style: AnsiStyle): boolean {
  return (
    style.fg === null &&
    !style.bold &&
    !style.dim &&
    !style.italic &&
    !style.underline &&
    !style.strike
  );
}

// 端末出力は 1 本の文字列だが、SGR の区間と URL で切って描く。innerHTML は使わない。
export function OutputText({ text }: { text: string }) {
  const parts = useMemo(() => linkify(parseAnsi(text)), [text]);

  return (
    <>
      {parts.map((part, index) => {
        const content =
          part.kind === "link" ? (
            <a href={part.href} target="_blank" rel="noopener noreferrer">
              {part.text}
            </a>
          ) : (
            part.text
          );
        return unstyled(part.style) ? (
          <Fragment key={index}>{content}</Fragment>
        ) : (
          <span key={index} style={css(part.style)}>
            {content}
          </span>
        );
      })}
    </>
  );
}
