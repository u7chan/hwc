import type { ComponentChild } from "preact";
import { useRef, useState } from "preact/hooks";
import { attachmentTypeLabels, MAX_ATTACHMENTS } from "../shared/attachments";
import { CollapseIcon, ImageIcon, NewSessionIcon, PlusIcon, RepoIcon } from "./icons";
import { Menu } from "./Menu";

export const ADD_MENU_ID = "hwc-add-menu";

export type ComposerCommand = {
  label: string;
  available: boolean;
  hint: string;
  run: () => void;
};

type ComposerAddProps = {
  full: boolean;
  // コマンドを持たない agent では null。画像とプロジェクトだけの + メニューになる。
  commands: { newSession: ComposerCommand; compact: ComposerCommand } | null;
  onFiles: (files: File[]) => void;
  onProjects: () => void;
};

// 入力欄の下から、本文に足すものと会話への操作を選ぶ。画像は既存のアップロード経路へ流し、
// プロジェクトは選んだディレクトリを本文へ入れる。会話コマンドは実行だけを親へ渡し、
// 下書き・添付・引用は残す。
export function ComposerAdd(props: ComposerAddProps) {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const close = () => setOpen(false);

  const command = (item: ComposerCommand, icon: ComponentChild) => (
    <button
      type="button"
      role="menuitem"
      class="hwc-menu-item hwc-add-item"
      disabled={!item.available}
      onClick={() => {
        close();
        item.run();
      }}
    >
      {icon}
      <span class="hwc-add-item-text">
        <span>{item.label}</span>
        <span class="hwc-add-item-hint">{item.hint}</span>
      </span>
    </button>
  );

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        class="hwc-add"
        aria-label="入力欄の操作"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={ADD_MENU_ID}
        onClick={() => setOpen((current) => !current)}
      >
        <PlusIcon size={20} />
      </button>
      <input
        ref={file}
        class="hwc-visually-hidden"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          // 同じファイルをもう一度選べるよう、値を戻してから渡す。
          event.currentTarget.value = "";
          if (files.length > 0) props.onFiles(files);
        }}
      />
      {trigger === null ? null : (
        <Menu
          id={ADD_MENU_ID}
          label="入力欄の操作"
          trigger={trigger}
          side="above"
          open={open}
          onClose={close}
        >
          {props.commands === null ? null : (
            <>
              {command(props.commands.newSession, <NewSessionIcon size={18} />)}
              {command(props.commands.compact, <CollapseIcon size={18} />)}
              <hr class="hwc-menu-separator" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            class="hwc-menu-item hwc-add-item"
            disabled={props.full}
            onClick={() => {
              close();
              file.current?.click();
            }}
          >
            <ImageIcon size={18} />
            <span class="hwc-add-item-text">
              <span>画像を追加</span>
              <span class="hwc-add-item-hint">
                {props.full ? `${MAX_ATTACHMENTS} 枚まで添付済み` : attachmentTypeLabels()}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="hwc-menu-item hwc-add-item"
            onClick={() => {
              close();
              props.onProjects();
            }}
          >
            <RepoIcon size={18} />
            <span class="hwc-add-item-text">
              <span>プロジェクトを選ぶ</span>
              <span class="hwc-add-item-hint">このディレクトリ配下から探す</span>
            </span>
          </button>
        </Menu>
      )}
    </>
  );
}
