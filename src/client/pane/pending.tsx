import { useState } from "preact/hooks";
import type { ChatPending } from "../../server/chat/contract";
import type { QuestionAnswer } from "../../shared/answer";
import type { AnswerResult } from "../api";
import {
  answerFailure,
  answersOf,
  type Choice,
  NO_CHOICE,
  pickLabel,
  pickOther,
  typeOther,
} from "../answer";
import { CheckIcon, StatusMark } from "../icons";
import { Spinner } from "../Spinner";

type Question = Extract<ChatPending, { kind: "question" }>;

// 人間の応答待ち。会話の末尾に 1 枚だけ置く。質問には選択肢か自由入力で答えられる。承認は
// 端末で行う（ADR 0098、0099）。
export function PendingCard(props: {
  pending: ChatPending;
  onShowTerminal: () => void;
  onAnswer: (pending: Question, answers: QuestionAnswer[]) => Promise<AnswerResult>;
}) {
  const pending = props.pending;
  return (
    <li class="hwc-pending">
      {pending.kind === "question" ? (
        // 質問が変わったら選択を持ち越さない。
        <QuestionForm key={pending.toolUseId} pending={pending} onAnswer={props.onAnswer} />
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

// 送信後は、質問が消える（Claude が受け取って pending が解ける）までカードを残して無効にする。
// 閉じてしまうと、消える前に同じ質問へ重ねて送れる。失敗したときだけ、入力を残して戻す。
type Phase = "editing" | "sending" | "sent";

function QuestionForm(props: {
  pending: Question;
  onAnswer: (pending: Question, answers: QuestionAnswer[]) => Promise<AnswerResult>;
}) {
  const { pending } = props;
  const [choices, setChoices] = useState<Choice[]>([]);
  const [phase, setPhase] = useState<Phase>("editing");
  const [failure, setFailure] = useState<string | null>(null);

  const choiceAt = (index: number): Choice => choices[index] ?? NO_CHOICE;
  const update = (index: number, next: Choice) => {
    setFailure(null);
    setChoices((current) => {
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
  };
  // 答えが揃っているかは、選択から毎回導く。
  const answers = answersOf(pending.questions, choices);
  const locked = phase !== "editing";

  const submit = async () => {
    if (answers === null || locked) return;
    setPhase("sending");
    setFailure(null);
    const result = await props.onAnswer(pending, answers);
    if (result.ok) {
      setPhase("sent");
      return;
    }
    setPhase("editing");
    setFailure(answerFailure(result.status));
  };

  return (
    <>
      <p class="hwc-pending-head">
        <StatusMark tone="attention" size={12} />
        Claude からの質問
      </p>
      <ol class="hwc-pending-questions">
        {pending.questions.map((question, index) => {
          const choice = choiceAt(index);
          return (
            <li class="hwc-pending-question" key={index}>
              {question.header === null ? null : (
                <span class="hwc-pending-label-head">{question.header}</span>
              )}
              <p class="hwc-pending-text">{question.question}</p>
              <ul class="hwc-pending-options">
                {question.options.map((option, optionIndex) => (
                  <li key={optionIndex}>
                    <ChoiceButton
                      multi={question.multiSelect}
                      selected={choice.labels.includes(option.label)}
                      disabled={locked}
                      label={option.label}
                      description={option.description}
                      onClick={() => update(index, pickLabel(question, choice, option.label))}
                    />
                  </li>
                ))}
                <li>
                  <ChoiceButton
                    multi={false}
                    selected={choice.other}
                    disabled={locked}
                    label="その他（自由入力）"
                    description={null}
                    onClick={() => update(index, pickOther(choice))}
                  />
                  {choice.other ? (
                    <textarea
                      class="hwc-pending-other"
                      rows={2}
                      value={choice.text}
                      disabled={locked}
                      aria-label={`${question.question} の自由入力`}
                      onInput={(event) =>
                        update(index, typeOther(choice, event.currentTarget.value))
                      }
                    />
                  ) : null}
                </li>
              </ul>
              {question.multiSelect ? <p class="hwc-pending-note">複数選べます</p> : null}
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        class="hwc-dialog-button hwc-dialog-primary hwc-pending-submit"
        disabled={answers === null || locked}
        onClick={() => void submit()}
      >
        {phase === "sending" ? <Spinner /> : null}
        この内容で答える
      </button>
      {phase === "sent" ? (
        <p class="hwc-pending-note" role="status">
          回答を送りました。Claude の応答を待っています。
        </p>
      ) : failure === null ? null : (
        <p class="hwc-pending-error" role="status">
          <StatusMark tone="attention" size={12} />
          {failure}
        </p>
      )}
    </>
  );
}

// 単一選択は丸、複数選択は四角の印を置く。色だけで選択を示さず、チェックで重ねて示す。
function ChoiceButton(props: {
  multi: boolean;
  selected: boolean;
  disabled: boolean;
  label: string;
  description: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="hwc-pending-choice"
      data-selected={props.selected}
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span class="hwc-pending-mark" data-multi={props.multi} aria-hidden="true">
        {props.selected ? <CheckIcon size={12} /> : null}
      </span>
      <span class="hwc-pending-choice-text">
        <span class="hwc-pending-option-label">{props.label}</span>
        {props.description === null ? null : (
          <span class="hwc-pending-option-description">{props.description}</span>
        )}
      </span>
    </button>
  );
}
