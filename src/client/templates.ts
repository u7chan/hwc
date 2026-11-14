import type { Template } from "../shared/templates";

// 名前の部分一致だけを見る。30 件上限なので、プロジェクト候補のような順位付けはしない。
export function filterTemplates(templates: readonly Template[], query: string): Template[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return [...templates];
  return templates.filter((template) => template.title.toLowerCase().includes(normalized));
}

// 設定の一覧に出す 1 行。本文の最初の空でない行を、前後の空白を落として返す。
export function templatePreview(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

export type TemplateInsertion = {
  text: string;
  caret: number;
};

// 選んだ本文をカーソル位置（選択範囲は置換）へ入れる。前後の文字とくっつかないよう、
// 段落として空行 1 つを挟む。既に空行が続いている側には足さない。
export function insertTemplate(
  draft: string,
  start: number,
  end: number,
  body: string,
): TemplateInsertion {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead =
    before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail =
    after === "" || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return {
    text: `${before}${lead}${body}${trail}${after}`,
    caret: before.length + lead.length + body.length,
  };
}

// crypto.randomUUID は secure context に限られ、LAN の HTTP では使えない。
// 一覧の中で重複しなければよいので、時刻と乱数から作る。
export function newTemplateId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
