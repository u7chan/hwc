type BuildSettingsProps = {
  revision: string | null;
};

export function BuildSettings(props: BuildSettingsProps) {
  return (
    <section>
      <div class="hwc-setting-group">
        <div class="hwc-setting-row">
          <span class="hwc-setting-label">コミット</span>
          <span class="hwc-setting-value">{props.revision ?? "取得できませんでした"}</span>
        </div>
      </div>
    </section>
  );
}
