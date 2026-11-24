import type { AttachedFile } from "../attachment-store";
import { type CommandId, commandSendText, commandText } from "../commands";

// 送信の起点。何を送るかはここで決まる。
export type SendSource =
  | { kind: "draft"; draft: string; attachments: readonly AttachedFile[] }
  | { kind: "chip"; id: CommandId; draft: string }
  | { kind: "menu"; id: CommandId };

export type ComposerSend = {
  text: string;
  // 一緒に送る添付の名前。保存が終わるまでは名前が無いので、その間は送らない。
  names: string[];
};

// 添付は入力欄の本文にだけ付く。チップは書きかけの本文を compact の指示として後ろに
// 付け、メニューの項目はコマンド文字列だけを送る。書きかけの本文と添付は、チップと
// メニューでは次のメッセージのために残す。
export function composerSend(source: SendSource): ComposerSend {
  switch (source.kind) {
    case "draft":
      return {
        text: source.draft,
        names: source.attachments.flatMap((item) => (item.name === null ? [] : [item.name])),
      };
    case "chip":
      return { text: commandSendText(source.id, source.draft), names: [] };
    case "menu":
      return { text: commandText(source.id), names: [] };
  }
}
