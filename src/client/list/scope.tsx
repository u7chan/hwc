import { countLabel, type ListScope } from "../scope";

const SCOPE_OPTIONS: readonly { scope: ListScope; label: string }[] = [
  { scope: "all", label: "すべて" },
  { scope: "active", label: "アクティブ" },
];

export function ScopeBar(props: {
  scope: ListScope;
  count: number;
  onScope: (scope: ListScope) => void;
}) {
  return (
    <div class="hwc-scope" role="group" aria-label="一覧の絞り込み" data-scope={props.scope}>
      <span class="hwc-scope-thumb" aria-hidden="true" />
      {SCOPE_OPTIONS.map((option) => {
        // 件数はアクティブ一覧の帯（スペース）の数。行数ではない。0 のときは何も出さない。
        const count = option.scope === "active" ? props.count : 0;
        return (
          <button
            key={option.scope}
            type="button"
            class="hwc-scope-option"
            aria-pressed={props.scope === option.scope}
            aria-label={count > 0 ? `${option.label}、${count} スペース` : undefined}
            onClick={() => props.onScope(option.scope)}
          >
            {option.label}
            {count > 0 && (
              <span class="hwc-scope-count" aria-hidden="true">
                {countLabel(count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
