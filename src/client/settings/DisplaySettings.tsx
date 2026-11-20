import { FILE_TREE_SIDES, type FileTreeSide } from "../file-tree-side";
import type { ThemePreference } from "../theme";
import { Segmented } from "../Segmented";
import { ThemePicker } from "./ThemePicker";

type DisplaySettingsProps = {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  treeSide: FileTreeSide;
  onTreeSideChange: (side: FileTreeSide) => void;
};

export function DisplaySettings(props: DisplaySettingsProps) {
  return (
    <section>
      <ThemePicker value={props.theme} onChange={props.onThemeChange} />
      <p class="hwc-section-note">システムは端末の外観設定に合わせます。</p>

      <p class="hwc-subtitle">ファイルツリーの位置</p>
      <Segmented
        label="ファイルツリーの位置"
        options={FILE_TREE_SIDES}
        value={props.treeSide}
        onChange={props.onTreeSideChange}
      />
      <p class="hwc-section-note">
        広いセルでツリーを会話の左右どちらに並べるかです。狭いセルでは会話の上に重ねます。
      </p>
    </section>
  );
}
