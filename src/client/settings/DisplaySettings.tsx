import { CODE_FONT_SIZES, type CodeFontSize } from "../code-font-size";
import {
  FILE_TREE_ICONS,
  FILE_TREE_SIZES,
  type FileTreeIcons,
  type FileTreeSize,
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
  treeIcons: FileTreeIcons;
  onTreeIconsChange: (icons: FileTreeIcons) => void;
  codeSize: CodeFontSize;
  onCodeSizeChange: (size: CodeFontSize) => void;
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

      <p class="hwc-subtitle">ファイルツリーのアイコン</p>
      <Segmented
        label="ファイルツリーのアイコン"
        options={FILE_TREE_ICONS}
        value={props.treeIcons}
        onChange={props.onTreeIconsChange}
      />
      <p class="hwc-section-note">
        ファイルとフォルダの行の左に、種類の印を付けます。フォルダは開くと形が変わります。既定の「なし」は今の見た目です。
      </p>

      <p class="hwc-subtitle">ソースコードの文字の大きさ</p>
      <Segmented
        label="ソースコードの文字の大きさ"
        options={CODE_FONT_SIZES}
        value={props.codeSize}
        onChange={props.onCodeSizeChange}
      />
      <p class="hwc-section-note">
        ファイルプレビューでソースを表示するときの大きさです。Markdown
        の本文、会話、端末出力は変わりません。
      </p>

      <p class="hwc-subtitle">サンプル</p>
      <FileTreeSample icons={props.treeIcons} />
      <p class="hwc-section-note">
        ツリーの幅は、会話の脇に並べたツリーの境目をドラッグして変えます。サンプルはその幅で表示し、この画面に収まらないときだけ狭めます。
      </p>
    </section>
  );
}
