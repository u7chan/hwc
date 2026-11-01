import { useRef } from "preact/hooks";
import { Spinner } from "./Spinner";
import { ReturnIcon } from "./icons";
import type { ShellPrompt } from "./prompt";

type TerminalInputProps = {
  prompt: ShellPrompt | null;
  value: string;
  sending: boolean;
  feedback: string | null;
  label: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
};

function promptPath(prompt: ShellPrompt | null): string {
  if (prompt === null) return "";
  return prompt.user === null ? prompt.path : `${prompt.user}:${prompt.path}`;
}

// 端末のペインは会話ではなくコマンドを流す。1 行の入力にし、Enter で送る。
export function TerminalInput(props: TerminalInputProps) {
  const field = useRef<HTMLInputElement>(null);
  const path = promptPath(props.prompt);

  return (
    <form
      class="hwc-input hwc-input--term"
      onSubmit={(event) => {
        event.preventDefault();
        // 送ったらキーボードを閉じる。端末の出力を見せる。
        field.current?.blur();
        props.onSubmit();
      }}
    >
      <label class="hwc-visually-hidden" for="hwc-term-field">
        {props.label}
      </label>
      {/* パスとユーザー名は入力の上へ逃がす。入力欄の幅を奪わず、届くのが遅れても高さが動かない。 */}
      <p class="hwc-term-path">{path}</p>
      <div class="hwc-term">
        <span class="hwc-term-mark" aria-hidden="true">
          {props.prompt?.mark ?? "$"}
        </span>
        <input
          id="hwc-term-field"
          ref={field}
          class="hwc-term-field"
          type="text"
          value={props.value}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          enterkeyhint="send"
          onInput={(event) => props.onValueChange(event.currentTarget.value)}
        />
        <button
          type="submit"
          class="hwc-send"
          aria-label={props.sending ? "送信中" : "送信"}
          disabled={props.value.trim() === "" || props.sending}
        >
          {props.sending ? <Spinner /> : <ReturnIcon />}
        </button>
      </div>
      <span class="hwc-feedback" aria-live="polite">
        {props.feedback}
      </span>
    </form>
  );
}
