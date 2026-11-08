import { expect, test } from "bun:test";
import { DEFAULT_ANSI_STYLE, type AnsiSegment, type AnsiStyle } from "./ansi";
import { linkify } from "./links";

function text(value: string, style: AnsiStyle = DEFAULT_ANSI_STYLE): AnsiSegment {
  return { text: value, style };
}

test("a bare URL becomes a link and keeps the surrounding text", () => {
  expect(linkify([text("see http://localhost:30000 (515d9d5)")])).toEqual([
    { kind: "text", text: "see ", style: DEFAULT_ANSI_STYLE },
    {
      kind: "link",
      text: "http://localhost:30000",
      href: "http://localhost:30000/",
      style: DEFAULT_ANSI_STYLE,
    },
    { kind: "text", text: " (515d9d5)", style: DEFAULT_ANSI_STYLE },
  ]);
});

test("a URL keeps the color of the segment it appears in", () => {
  const style = { ...DEFAULT_ANSI_STYLE, fg: { kind: "basic" as const, index: 4 } };

  expect(linkify([text("https://example.com/path", style)])).toEqual([
    {
      kind: "link",
      text: "https://example.com/path",
      href: "https://example.com/path",
      style,
    },
  ]);
});

test("trailing punctuation is not part of the URL", () => {
  const url = (value: string) => {
    const [part] = linkify([text(value)]);
    return part?.kind === "link" ? [part.text, part.href] : null;
  };

  expect(url("http://example.com.")).toEqual(["http://example.com", "http://example.com/"]);
  expect(url("http://example.com, next")).toEqual(["http://example.com", "http://example.com/"]);
  expect(url("http://example.com/a;")).toEqual(["http://example.com/a", "http://example.com/a"]);
  expect(url("http://example.com/a:")).toEqual(["http://example.com/a", "http://example.com/a"]);
});

test("a closing bracket is kept only when it is balanced", () => {
  const link = (value: string) => {
    const part = linkify([text(value)]).find((item) => item.kind === "link");
    return part?.kind === "link" ? part.text : null;
  };

  expect(link("(http://example.com/a)")).toBe("http://example.com/a");
  expect(link("http://example.com/a(b)")).toBe("http://example.com/a(b)");
  expect(link("http://example.com/a).")).toBe("http://example.com/a");
  expect(link("http://example.com/a]")).toBe("http://example.com/a");
  expect(link("http://example.com/a[1]")).toBe("http://example.com/a[1]");
  expect(link("（http://example.com/a）")).toBe("http://example.com/a");
  expect(link("http://example.com/a（b）")).toBe("http://example.com/a（b）");
});

test("Japanese punctuation after a URL is not part of the URL", () => {
  const link = (value: string) => {
    const part = linkify([text(value)]).find((item) => item.kind === "link");
    return part?.kind === "link" ? part.text : null;
  };

  expect(link("http://example.com/a、次の文")).toBe("http://example.com/a");
  expect(link("http://example.com/a。")).toBe("http://example.com/a");
  expect(link("http://example.com/a…")).toBe("http://example.com/a");
});

test("quotes and angle brackets end the URL", () => {
  const link = (value: string) => {
    const part = linkify([text(value)]).find((item) => item.kind === "link");
    return part?.kind === "link" ? part.text : null;
  };

  expect(link('"http://example.com/a"')).toBe("http://example.com/a");
  expect(link("'http://example.com/a'")).toBe("http://example.com/a");
  expect(link("<http://example.com/a>")).toBe("http://example.com/a");
  expect(link("`http://example.com/a`")).toBe("http://example.com/a");
});

test("query strings and fragments stay in the URL", () => {
  const [part] = linkify([text("https://example.com/search?q=a&b=c#hit")]);

  expect(part?.kind === "link" ? part.href : null).toBe("https://example.com/search?q=a&b=c#hit");
});

test("the scheme is matched without case sensitivity", () => {
  const [part] = linkify([text("HTTP://Example.COM/Path")]);

  expect(part?.kind === "link" ? part.href : null).toBe("http://example.com/Path");
});

test("only http and https are linked", () => {
  expect(linkify([text("ftp://example.com mailto:dev@example.com")])).toEqual([
    { kind: "text", text: "ftp://example.com mailto:dev@example.com", style: DEFAULT_ANSI_STYLE },
  ]);
  expect(linkify([text("javascript://alert")])).toEqual([
    { kind: "text", text: "javascript://alert", style: DEFAULT_ANSI_STYLE },
  ]);
});

test("a bare domain or www address is not guessed to be a link", () => {
  expect(linkify([text("example.com and www.example.com")])).toEqual([
    { kind: "text", text: "example.com and www.example.com", style: DEFAULT_ANSI_STYLE },
  ]);
});

test("multiple URLs in one segment become separate links", () => {
  expect(linkify([text("http://a.example http://b.example")])).toEqual([
    {
      kind: "link",
      text: "http://a.example",
      href: "http://a.example/",
      style: DEFAULT_ANSI_STYLE,
    },
    { kind: "text", text: " ", style: DEFAULT_ANSI_STYLE },
    {
      kind: "link",
      text: "http://b.example",
      href: "http://b.example/",
      style: DEFAULT_ANSI_STYLE,
    },
  ]);
});

test("the host is never rewritten", () => {
  const [part] = linkify([text("http://127.0.0.1:5173/")]);

  expect(part?.kind === "link" ? part.href : null).toBe("http://127.0.0.1:5173/");
});

test("empty input produces no parts", () => {
  expect(linkify([])).toEqual([]);
});
