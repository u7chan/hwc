import type { ChatPending } from "../../server/chat/contract";
import { StatusMark } from "../icons";

// 人間の応答待ち。transcript の tool_use から作った内容を、会話の末尾に 1 枚だけ置く。
// 選択肢は押せない。回答は端末で行う（ADR 0098）。
export function PendingCard(props: { pending: ChatPending; onShowTerminal: () => void }) {
  const pending = props.pending;
  return (
    <li class="hwc-pending">
      {pending.kind === "question" ? (
        <>
          <p class="hwc-pending-head">
            <StatusMark tone="attention" size={12} />
            Claude からの質問
          </p>
          <ol class="hwc-pending-questions">
            {pending.questions.map((question, questionIndex) => (
              <li class="hwc-pending-question" key={questionIndex}>
                {question.header === null ? null : (
                  <span class="hwc-pending-label-head">{question.header}</span>
                )}
                <p class="hwc-pending-text">{question.question}</p>
                <ul class="hwc-pending-options">
                  {question.options.map((option, optionIndex) => (
                    <li class="hwc-pending-option" key={optionIndex}>
                      <span class="hwc-pending-option-label">{option.label}</span>
                      {option.description === null ? null : (
                        <span class="hwc-pending-option-description">{option.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {question.multiSelect ? <p class="hwc-pending-note">複数選べます</p> : null}
              </li>
            ))}
          </ol>
          <p class="hwc-pending-note">端末で答えてください。</p>
        </>
      ) : (
        <>
          <p class="hwc-pending-head">
            <StatusMark tone="attention" size={12} />
            承認待ち: {pending.tool}
          </p>
          {pending.summary === null ? null : <p class="hwc-pending-text">{pending.summary}</p>}
          <p class="hwc-pending-note">端末で応答してください。</p>
        </>
      )}
      <button type="button" class="hwc-pending-toggle" onClick={props.onShowTerminal}>
        端末出力を見る
      </button>
    </li>
  );
}
