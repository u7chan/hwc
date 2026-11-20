import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const files: string[] = [];
for await (const file of new Bun.Glob("docs/adr/*.md").scan(".")) files.push(file);
files.sort();

const docFiles: string[] = [];
for await (const file of new Bun.Glob("docs/**/*.md").scan(".")) docFiles.push(file);
docFiles.sort();

// 引用は番号だけで書く。番号が重複すると、どの判断を指すのか読み手にも検索にも決められない。
test("ADR のファイル名の番号は重複しない", () => {
  const byNumber = new Map<string, string[]>();
  for (const file of files) {
    const number = file.slice("docs/adr/".length).split("-")[0]!;
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }
  const duplicated = [...byNumber].filter(([, group]) => group.length > 1);
  expect(duplicated).toEqual([]);
});

test("ADR の見出しの番号はファイル名と一致する", async () => {
  const mismatched: string[] = [];
  for (const file of files) {
    const number = file.slice("docs/adr/".length).split("-")[0]!;
    const heading = (await Bun.file(file).text()).split("\n", 1)[0]!;
    if (!heading.startsWith(`# ADR ${number}:`)) mismatched.push(`${file}: ${heading}`);
  }
  expect(mismatched).toEqual([]);
});

test("ADR のリンクは、ラベルの番号と同じ番号のファイルを指す", async () => {
  const broken: string[] = [];
  for (const file of docFiles) {
    const text = await Bun.file(file).text();
    for (const [, label, target] of text.matchAll(/\[ADR (\d{4})[^\]]*\]\(([^)]+)\)/g)) {
      if (target === undefined || target.startsWith("http")) continue;
      const path = target.split("#")[0]!;
      if (!path.endsWith(".md")) continue;
      const resolved = join(dirname(file), path);
      if (!existsSync(resolved)) {
        broken.push(`${file}: ${target} が無い`);
        continue;
      }
      const number = resolved.slice(resolved.lastIndexOf("/") + 1).split("-")[0]!;
      if (number !== label) broken.push(`${file}: ADR ${label} は ${resolved} を指す`);
    }
  }
  expect(broken).toEqual([]);
});
