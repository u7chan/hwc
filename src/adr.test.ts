import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

async function scan(patterns: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of patterns) {
    for await (const file of new Bun.Glob(pattern).scan(".")) files.push(file);
  }
  return files.sort();
}

const adrFiles = await scan(["docs/adr/*.md"]);
const docFiles = await scan([
  "AGENTS.md",
  "README.md",
  "docs/**/*.md",
  ".agents/**/*.md",
  "claude-mod/**/*.md",
  "src/**/*.md",
  "e2e/**/*.md",
]);
const sourceFiles = await scan(
  ["src", "e2e", "claude-mod"].flatMap((dir) =>
    ["ts", "tsx", "css", "mjs", "md"].map((ext) => `${dir}/**/*.${ext}`),
  ),
);
const referringFiles = [...new Set([...docFiles, ...sourceFiles])];

// 番号は並列のブランチが同時に同じ値を取る。名前は同じ論点のときだけ衝突し、git の衝突として気付ける。
test("ADR のファイル名は番号を持たない小文字 kebab-case にする", () => {
  const invalid = adrFiles.filter(
    (file) => !/^[a-z][a-z0-9]*(-[a-z0-9]+)*\.md$/.test(file.slice("docs/adr/".length)),
  );
  expect(invalid).toEqual([]);
});

test("ADR は見出しと、Accepted か Proposed の Status を持つ", async () => {
  const invalid: string[] = [];
  for (const file of adrFiles) {
    const text = await Bun.file(file).text();
    if (!text.startsWith("# ")) invalid.push(`${file}: 見出しが無い`);
    if (!/^- Status: (Accepted|Proposed)$/m.test(text)) invalid.push(`${file}: Status が無い`);
  }
  expect(invalid).toEqual([]);
});

test("ドキュメントの相対リンクは実在するファイルを指す", async () => {
  const broken: string[] = [];
  for (const file of docFiles) {
    // コードフェンスの中の `a[i](x)` はリンクではない。
    const text = (await Bun.file(file).text()).replace(/^```[\s\S]*?^```/gm, "");
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (target === undefined || /^(https?:|mailto:|#)/.test(target)) continue;
      const path = join(dirname(file), target.split("#")[0]!);
      if (!existsSync(path)) broken.push(`${file}: ${target}`);
    }
  }
  expect(broken).toEqual([]);
});

test("コードとドキュメントが参照する ADR は実在する", async () => {
  const missing: string[] = [];
  for (const file of referringFiles) {
    const text = await Bun.file(file).text();
    for (const [match] of text.matchAll(/docs\/adr\/[A-Za-z0-9_.-]+/g)) {
      const path = match.replace(/\.+$/, "");
      if (!existsSync(path)) missing.push(`${file}: ${path}`);
    }
  }
  expect(missing).toEqual([]);
});

test("ADR を番号で参照しない", async () => {
  const numbered: string[] = [];
  for (const file of referringFiles) {
    const text = await Bun.file(file).text();
    text.split("\n").forEach((line, index) => {
      if (/ADR[\s-]?\d{3,4}(?!\d)|adr\/\d{3,4}-/.test(line)) numbered.push(`${file}:${index + 1}`);
    });
  }
  expect(numbered).toEqual([]);
});
