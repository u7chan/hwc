import { useEffect, useState } from "preact/hooks";
import {
  characterCount,
  MAX_TEMPLATES,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_TITLE_LENGTH,
  type Template,
} from "../shared/templates";
import { fetchTemplates, saveTemplates, type TemplateSaveResult } from "./api";
import { Confirm } from "./Confirm";
import { ChevronRightIcon, PlusIcon, TemplateIcon } from "./icons";
import { newTemplateId, templatePreview } from "./templates";

type LoadState = "loading" | "ready" | "failed";

type Editing = { kind: "new" } | { kind: "edit"; id: string };

function saveErrorText(error: string | null): string {
  if (error === "invalid_request") return "入力が条件を満たしていません。";
  return "保存できませんでした。";
}

// 設定は BFF が正。保存後の応答で一覧を丸ごと置き換え、画面と保存済みの一覧を食い違わせない。
export function TemplateSettings() {
  const [view, setView] = useState<Template[] | null>(null);
  const [load, setLoad] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoad("loading");
    fetchTemplates(controller.signal).then(
      (templates) => {
        if (controller.signal.aborted) return;
        if (templates === null) {
          // 読み込めないまま「0 件」と出すと、既存の一覧を上書きしてしまう。
          setLoad("failed");
          return;
        }
        setView(templates);
        setLoad("ready");
      },
      () => {
        if (!controller.signal.aborted) setLoad("failed");
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  const applySave = (result: TemplateSaveResult): boolean => {
    if (result.ok) {
      setView(result.templates);
      setEditing(null);
      setMessage(null);
      return true;
    }
    setMessage(saveErrorText(result.error));
    return false;
  };

  const startNew = () => {
    if (busy || view === null || view.length >= MAX_TEMPLATES) return;
    setEditing({ kind: "new" });
    setTitle("");
    setBody("");
    setMessage(null);
  };

  const startEdit = (template: Template) => {
    if (busy) return;
    setEditing({ kind: "edit", id: template.id });
    setTitle(template.title);
    setBody(template.body);
    setMessage(null);
  };

  const cancelEdit = () => {
    if (busy) return;
    setEditing(null);
    setMessage(null);
  };

  const titleValue = title.trim().replace(/\s+/g, " ");
  const bodyValue = body.replace(/\r\n/g, "\n").trim();
  const bodyOver = characterCount(body) > MAX_TEMPLATE_BODY_LENGTH;
  const canSave = !busy && titleValue !== "" && bodyValue !== "";

  const submit = async () => {
    if (!canSave || view === null || editing === null) return;
    if (editing.kind === "new" && view.length >= MAX_TEMPLATES) {
      setMessage(`定型文は ${MAX_TEMPLATES} 件までです。`);
      return;
    }
    if (characterCount(titleValue) > MAX_TEMPLATE_TITLE_LENGTH) {
      setMessage(`名前は ${MAX_TEMPLATE_TITLE_LENGTH} 文字までです。`);
      return;
    }
    if (characterCount(bodyValue) > MAX_TEMPLATE_BODY_LENGTH) {
      setMessage(`本文は ${MAX_TEMPLATE_BODY_LENGTH} 文字までです。`);
      return;
    }
    const next =
      editing.kind === "new"
        ? [...view, { id: newTemplateId(), title: titleValue, body: bodyValue }]
        : view.map((template) =>
            template.id === editing.id
              ? { ...template, title: titleValue, body: bodyValue }
              : template,
          );
    setBusy(true);
    applySave(await saveTemplates(next));
    setBusy(false);
  };

  const remove = async (id: string) => {
    setConfirmDelete(false);
    if (busy || view === null) return;
    setBusy(true);
    applySave(await saveTemplates(view.filter((template) => template.id !== id)));
    setBusy(false);
  };

  const editingTemplate =
    editing?.kind === "edit" && view !== null
      ? (view.find((template) => template.id === editing.id) ?? null)
      : null;

  return (
    <section class="hwc-section">
      <h3 class="hwc-section-title">定型文</h3>

      {load === "loading" ? (
        <p class="hwc-section-note">定型文を読み込んでいます。</p>
      ) : load === "failed" || view === null ? (
        <div class="hwc-setting-failure">
          <p class="hwc-section-note" role="alert">
            定型文を読み込めませんでした。
          </p>
          <button
            type="button"
            class="hwc-setting-button"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            再試行
          </button>
        </div>
      ) : editing === null ? (
        <>
          {view.length === 0 ? (
            <div class="hwc-template-empty">
              <span class="hwc-template-empty-mark">
                <TemplateIcon size={32} />
              </span>
              <p class="hwc-template-empty-title">まだ定型文がありません</p>
              <p class="hwc-template-empty-note">
                よく送る指示を登録すると、入力欄の + から選べます。
              </p>
              <button
                type="button"
                class="hwc-setting-button hwc-setting-primary"
                disabled={busy}
                onClick={startNew}
              >
                <PlusIcon size={16} />
                定型文を追加
              </button>
            </div>
          ) : (
            <div class="hwc-setting-group">
              {view.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  class="hwc-template-row"
                  disabled={busy}
                  onClick={() => startEdit(template)}
                >
                  <span class="hwc-template-row-text">
                    <span class="hwc-template-row-name">{template.title}</span>
                    <span class="hwc-template-row-preview">{templatePreview(template.body)}</span>
                  </span>
                  <ChevronRightIcon size={16} />
                </button>
              ))}
            </div>
          )}

          {view.length === 0 ? null : (
            <div class="hwc-setting-actions">
              <button
                type="button"
                class="hwc-setting-button"
                disabled={busy || view.length >= MAX_TEMPLATES}
                onClick={startNew}
              >
                <PlusIcon size={16} />
                定型文を追加
              </button>
            </div>
          )}

          <p class="hwc-section-note">
            入力欄の + から本文に引用できます。{MAX_TEMPLATES} 件・名前 {MAX_TEMPLATE_TITLE_LENGTH}{" "}
            文字・本文 {MAX_TEMPLATE_BODY_LENGTH} 文字まで。
            {view.length >= MAX_TEMPLATES ? " 上限に達しています。" : ""}
          </p>
        </>
      ) : (
        <div class="hwc-setting-group">
          <form
            class="hwc-template-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label class="hwc-template-label" for="hwc-template-name">
              名前
            </label>
            <input
              id="hwc-template-name"
              class="hwc-setting-input"
              type="text"
              value={title}
              autocomplete="off"
              disabled={busy}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
            <label class="hwc-template-label" for="hwc-template-body">
              本文
            </label>
            <textarea
              id="hwc-template-body"
              class="hwc-template-body"
              value={body}
              rows={6}
              disabled={busy}
              onInput={(event) => setBody(event.currentTarget.value)}
            />
            <span class="hwc-template-counter" data-over={bodyOver}>
              {characterCount(body)} / {MAX_TEMPLATE_BODY_LENGTH}
            </span>

            {message === null ? null : (
              <p class="hwc-setting-result" data-ok={false} role="alert">
                {message}
              </p>
            )}

            <div class="hwc-setting-actions">
              <button
                type="submit"
                class="hwc-setting-button hwc-setting-primary"
                disabled={!canSave}
              >
                保存
              </button>
              <button type="button" class="hwc-setting-button" disabled={busy} onClick={cancelEdit}>
                キャンセル
              </button>
              {editingTemplate === null ? null : (
                <button
                  type="button"
                  class="hwc-setting-button hwc-template-delete"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  削除
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      {confirmDelete && editingTemplate !== null ? (
        <Confirm
          title="定型文を削除"
          description={`「${editingTemplate.title}」を削除します。入力欄の + から選べなくなります。`}
          confirmLabel="削除"
          busy={busy}
          onConfirm={() => void remove(editingTemplate.id)}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </section>
  );
}
