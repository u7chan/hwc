import { useEffect, useRef, useState } from "preact/hooks";
import { characterCount, type Template } from "../shared/templates";
import { fetchTemplates } from "./api";
import { DialogShell } from "./Dialog";
import { Spinner } from "./Spinner";
import { filterTemplates } from "./templates";

type Load = { kind: "loading" } | { kind: "ready"; templates: Template[] } | { kind: "failed" };

type TemplateDialogProps = {
  open: boolean;
  onClose: () => void;
  onExited: () => void;
  onPick: (body: string) => void;
};

// 名前を選ぶだけでは本文を変えない。引用するのは「引用する」を押したときだけ。
// 検索は自動フォーカスしない（キーボードがプレビューを潰すため）。
export function TemplateDialog(props: TemplateDialogProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const chips = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    setSelectedId(null);
    void fetchTemplates(controller.signal).then((templates) => {
      if (!active) return;
      setLoad(templates === null ? { kind: "failed" } : { kind: "ready", templates });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  const templates = load.kind === "ready" ? load.templates : [];
  const visible = load.kind === "ready" ? filterTemplates(templates, query) : [];
  const selected = visible.find((template) => template.id === selectedId) ?? null;

  const move = (index: number, step: number) => {
    if (visible.length === 0) return;
    const next = (index + step + visible.length) % visible.length;
    setSelectedId(visible[next]!.id);
    chips.current[next]?.focus();
  };

  return (
    <DialogShell
      role="dialog"
      className="hwc-template-dialog"
      labelledBy="hwc-template-title"
      describedBy="hwc-template-note"
      open={props.open}
      onClose={props.onClose}
      onExited={props.onExited}
    >
      <h2 class="hwc-dialog-title" id="hwc-template-title">
        定型文を引用
      </h2>
      <p class="hwc-dialog-text" id="hwc-template-note">
        選ぶだけでは下書きは変わりません。「引用する」を押すと、本文がカーソル位置に加わります。
      </p>

      <label class="hwc-template-search">
        <span class="hwc-visually-hidden">定型文を名前で絞り込む</span>
        <input
          class="hwc-create-input"
          type="search"
          value={query}
          placeholder="名前で絞り込む"
          autocomplete="off"
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            // 絞り込みで名前の一覧が入れ替わる。前の選択を持ち越さない。
            setSelectedId(null);
          }}
        />
      </label>

      <div class="hwc-template-content">
        {load.kind === "loading" ? (
          <p class="hwc-template-state" role="status">
            <Spinner size={16} />
            読み込み中…
          </p>
        ) : load.kind === "failed" ? (
          <div class="hwc-template-state">
            <span role="status">定型文を読み込めませんでした。</span>
            <button
              type="button"
              class="hwc-template-retry"
              onClick={() => setAttempt((current) => current + 1)}
            >
              再試行
            </button>
          </div>
        ) : templates.length === 0 ? (
          <p class="hwc-template-state">まだ定型文がありません。設定で登録できます。</p>
        ) : visible.length === 0 ? (
          <p class="hwc-template-state">「{query.trim()}」に一致する定型文がありません。</p>
        ) : (
          <>
            <div class="hwc-template-chips" role="radiogroup" aria-label="定型文">
              {visible.map((template, index) => (
                <button
                  key={template.id}
                  ref={(node) => {
                    chips.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  class="hwc-template-chip"
                  aria-checked={template.id === selectedId}
                  onClick={() => setSelectedId(template.id)}
                  onKeyDown={(event) => {
                    const step =
                      event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? 1
                        : event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? -1
                          : 0;
                    if (step === 0) return;
                    event.preventDefault();
                    move(index, step);
                  }}
                >
                  {template.title}
                </button>
              ))}
            </div>
            <div class="hwc-template-preview">
              {selected === null ? (
                <p class="hwc-template-preview-empty">定型文を選ぶと、本文がここに出ます。</p>
              ) : (
                <pre class="hwc-template-preview-text">{selected.body}</pre>
              )}
              <div class="hwc-template-preview-foot">
                <span>本文</span>
                <span>{selected === null ? "—" : `${characterCount(selected.body)} 文字`}</span>
              </div>
            </div>
          </>
        )}
      </div>

      <div class="hwc-dialog-actions">
        <button
          type="button"
          class="hwc-dialog-button hwc-dialog-primary"
          disabled={selected === null}
          onClick={() => {
            if (selected !== null) props.onPick(selected.body);
          }}
        >
          引用する
        </button>
        <button type="button" class="hwc-dialog-button hwc-dialog-cancel" onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </DialogShell>
  );
}
