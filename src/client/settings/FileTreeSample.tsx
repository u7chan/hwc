import { ChevronRightIcon, MoreIcon } from "../icons";
import { indent } from "../pane/file-tree";

type SampleRow = {
  name: string;
  depth: number;
  kind: "open-dir" | "dir" | "file";
  selected?: boolean;
};

// 実ファイルではない名前。`.test.ts` の 2 行は、標準の大きさと幅では末尾が省略される長さにしてある。
const ROWS: readonly SampleRow[] = [
  { name: "src", depth: 0, kind: "open-dir" },
  { name: "server", depth: 1, kind: "open-dir" },
  { name: "routes", depth: 2, kind: "dir" },
  { name: "invoice-summary.test.ts", depth: 2, kind: "file", selected: true },
  { name: "invoice-summary.ts", depth: 2, kind: "file" },
  { name: "app.invoice-summary.test.ts", depth: 2, kind: "file" },
];

function SampleLine({ row }: { row: SampleRow }) {
  const content = (
    <div
      class="hwc-tree-row"
      style={indent(row.depth)}
      data-selected={row.selected ? "true" : undefined}
    >
      <span class="hwc-tree-mark">
        {row.kind === "file" ? null : (
          <span class="hwc-tree-chevron" data-open={row.kind === "open-dir"}>
            <ChevronRightIcon size={16} />
          </span>
        )}
      </span>
      <span class="hwc-tree-name">{row.name}</span>
    </div>
  );
  if (row.kind === "file") return content;
  return (
    <div class="hwc-tree-line">
      {content}
      <span class="hwc-tree-action">
        <MoreIcon />
      </span>
    </div>
  );
}

// 設定の画面から、ツリーの文字の大きさと幅を試す。操作はできない見本なので、読み上げからは外す。
export function FileTreeSample() {
  return (
    <div class="hwc-tree-sample" aria-hidden="true">
      <ul class="hwc-tree">
        {ROWS.map((row) => (
          <li class="hwc-tree-item" key={`${row.depth}:${row.name}`}>
            <SampleLine row={row} />
          </li>
        ))}
      </ul>
    </div>
  );
}
