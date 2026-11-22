import {
  FILE_TREE_SIZES,
  FILE_TREE_WIDTHS,
  fileTreeWidthPx,
  type FileTreeSize,
  type FileTreeWidth,
} from "../file-tree-display";
import { FILE_TREE_SIDES, type FileTreeSide } from "../file-tree-side";
import type { ThemePreference } from "../theme";
import { Segmented } from "../Segmented";
import { FileTreeSample } from "./FileTreeSample";
import { ThemePicker } from "./ThemePicker";

type DisplaySettingsProps = {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  treeSide: FileTreeSide;
  onTreeSideChange: (side: FileTreeSide) => void;
  treeSize: FileTreeSize;
  onTreeSizeChange: (size: FileTreeSize) => void;
  treeWidth: FileTreeWidth;
  onTreeWidthChange: (width: FileTreeWidth) => void;
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

      <p class="hwc-subtitle">ファイルツリーの文字の大きさ</p>
      <Segmented
        label="ファイルツリーの文字の大きさ"
        options={FILE_TREE_SIZES}
        value={props.treeSize}
        onChange={props.onTreeSizeChange}
      />
      <p class="hwc-section-note">
        行の高さは変わりません。大きくすると、1 行に入る文字が減ります。
      </p>

      <p class="hwc-subtitle">ファイルツリーの幅</p>
      <Segmented
        label="ファイルツリーの幅"
        options={FILE_TREE_WIDTHS}
        value={props.treeWidth}
        onChange={props.onTreeWidthChange}
      />
      <p class="hwc-section-note">
        広いセルでツリーを並べるときの幅です。広くするほど、並べるのに必要なセルの幅も増えます。狭いセルでは会話の上に重ねるので、幅は変わりません。
      </p>

      <p class="hwc-subtitle">サンプル</p>
      <FileTreeSample />
      <p class="hwc-section-note">
        幅 {fileTreeWidthPx(props.treeWidth)}px。画面より広い幅は、画面の幅で止まります。
      </p>
    </section>
  );
}
