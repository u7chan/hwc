// 定型文は BFF が正。名前は一覧で選ぶボタン、本文は引用してそのまま下書きに加える。
// 変数展開や送信は持たない。上限と検証は BFF・設定画面・ダイアログで共有する。

export type Template = {
  id: string;
  title: string;
  body: string;
};

// スマホのダイアログで探せる範囲に留める。30 件を超えると名前の一覧が読みにくくなる。
export const MAX_TEMPLATES = 30;
export const MAX_TEMPLATE_TITLE_LENGTH = 40;
export const MAX_TEMPLATE_BODY_LENGTH = 2000;

// id はクライアントが crypto.randomUUID() で振る。保存は一覧まるごと置き換えるので、
// サーバーは並びと id を保つだけでよい。
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// 本文に改行とタブは許す。それ以外の制御文字は、入力欄やログで行が割れる原因になる。
function hasControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// 文字数はコードポイントで数える。絵文字を 2 文字と数えない。
export function characterCount(text: string): number {
  return [...text].length;
}

// 名前は 1 行にする。改行と連続する空白は 1 つに畳む。
function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim().replace(/\s+/g, " ");
  if (title === "" || characterCount(title) > MAX_TEMPLATE_TITLE_LENGTH) return null;
  return title;
}

function normalizeBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = value.replace(/\r\n/g, "\n").trim();
  if (body === "" || characterCount(body) > MAX_TEMPLATE_BODY_LENGTH) return null;
  if (hasControlChars(body)) return null;
  return body;
}

export function normalizeTemplate(value: unknown): Template | null {
  if (typeof value !== "object" || value === null) return null;
  const template = value as Partial<Template>;
  if (typeof template.id !== "string" || !TEMPLATE_ID.test(template.id)) return null;
  const title = normalizeTitle(template.title);
  const body = normalizeBody(template.body);
  if (title === null || body === null) return null;
  return { id: template.id, title, body };
}

// 応答と保存の両方で使う。1 件でも壊れていたら全体を拒む。部分的に正しい一覧を
// 保存すると、画面に出ていた定型文と保存された定型文が食い違う。
export function parseTemplates(value: unknown): Template[] | null {
  if (!Array.isArray(value) || value.length > MAX_TEMPLATES) return null;
  const templates: Template[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const template = normalizeTemplate(item);
    if (template === null || ids.has(template.id)) return null;
    ids.add(template.id);
    templates.push(template);
  }
  return templates;
}

// 状態ディレクトリのファイルは手で書き換えられ得る。読めない行だけを捨て、
// 残りで起動する。上限を超えた分は切り捨てる。
export function parseStoredTemplates(value: unknown): Template[] {
  if (!Array.isArray(value)) return [];
  const templates: Template[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const template = normalizeTemplate(item);
    if (template === null || ids.has(template.id)) continue;
    ids.add(template.id);
    templates.push(template);
    if (templates.length === MAX_TEMPLATES) break;
  }
  return templates;
}
