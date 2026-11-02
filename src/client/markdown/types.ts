// 移植元: u7chan/monorepo の projects/u7agent/client/src/lib/markdown/types.ts
/** Markdown サブセットの解析結果。DOM / Preact に依存しない値だけを持ち、Node のテストで固定する。 */

export type MdAlign = "left" | "center" | "right";

export type MdHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type MdListItem = {
  /** 項目の本文 (入れ子のリスト行を含む)。描画側が再帰的に解析する */
  source: string;
};

export type MdBlock =
  /** source はインライン記法を含む本文ソース */
  | { kind: "heading"; level: MdHeadingLevel; source: string }
  | { kind: "paragraph"; source: string }
  /** closed が false のときは未終端のフェンス (生成中の本文もそのまま出す) */
  | { kind: "code"; lang: string | null; text: string; closed: boolean }
  | { kind: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { kind: "quote"; source: string }
  | { kind: "table"; align: MdAlign[]; header: string[]; rows: string[][] }
  | { kind: "hr" };

export type MdInline =
  | { kind: "text"; text: string }
  /** 解析できなかった記法 (不正な URL のリンク・画像など)。原文を等幅で見せる */
  | { kind: "literal"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "del"; children: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; title: string | null; children: MdInline[] }
  | { kind: "break" };
