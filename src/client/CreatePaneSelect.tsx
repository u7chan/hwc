import type { ComponentChildren } from "preact";

export function CreatePaneSelect(props: {
  label: string;
  noteId: string;
  note: string | null;
  loading: boolean;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ComponentChildren;
}) {
  const description = props.loading ? `${props.label}を読み込み中…` : props.note;

  return (
    <>
      <label class="hwc-create-field">
        <span class="hwc-create-label">{props.label}</span>
        <span class="hwc-create-select">
          <select
            class="hwc-create-input"
            data-loading={props.loading}
            value={props.value}
            disabled={props.disabled}
            aria-busy={props.loading}
            aria-describedby={description === null ? undefined : props.noteId}
            onChange={(event) => props.onChange(event.currentTarget.value)}
          >
            {props.children}
          </select>
          {props.loading ? <span class="hwc-create-skeleton" aria-hidden="true" /> : null}
        </span>
      </label>
      {description === null ? null : (
        <p
          class={props.loading ? "hwc-visually-hidden" : "hwc-create-note"}
          id={props.noteId}
          role="status"
        >
          {description}
        </p>
      )}
    </>
  );
}
