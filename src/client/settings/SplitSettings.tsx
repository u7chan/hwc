import { SPLIT_MOTIONS, type SplitPrefs } from "../split-prefs";

type SplitSettingsProps = {
  prefs: SplitPrefs;
  onChange: (next: SplitPrefs) => void;
};

// 端末ごとの見え方なので、選ぶとその場で保存する（ADR 0092）。読み直しも無い。
export function SplitSettings(props: SplitSettingsProps) {
  const set = (patch: Partial<SplitPrefs>) => props.onChange({ ...props.prefs, ...patch });
  const { autoSplit, motion } = props.prefs;

  return (
    <section>
      <div class="hwc-setting-group">
        <div class="hwc-setting-row">
          <span class="hwc-setting-label">委譲で自動分割</span>
          <button
            type="button"
            role="switch"
            class="hwc-switch"
            aria-checked={autoSplit}
            aria-label="委譲で自動分割"
            data-on={autoSplit}
            onClick={() => set({ autoSplit: !autoSplit })}
          >
            <span class="hwc-switch-knob" />
          </button>
        </div>
      </div>
      <p class="hwc-section-note">
        別ペインのエージェントが増えたとき、いま見ているペインの隣に表示します。4
        枚を超えた分はタブに追加します。PC だけで働きます。
      </p>

      <p class="hwc-subtitle">分割の動き</p>
      <div class="hwc-segmented" role="radiogroup" aria-label="分割の動き">
        {SPLIT_MOTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            class="hwc-segment"
            aria-checked={motion === option.id}
            data-selected={motion === option.id}
            disabled={!autoSplit}
            onClick={() => set({ motion: option.id })}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p class="hwc-section-note">
        分割線が動く時間です。端末で「動きを減らす」を選んでいるときは、この設定より優先して止めます。
      </p>
    </section>
  );
}
