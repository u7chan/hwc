import { useState } from "preact/hooks";
import type { ChatPending } from "../../server/chat/contract";
import type { QuestionAnswer } from "../../shared/answer";
import type { AnswerResult } from "../api";
import {
  answerFailure,
  answersOf,
  ASK_FREE_TEXT_LABEL,
  askOptionLabel,
  askUserAnswers,
  type Choice,
  NO_CHOICE,
  pickLabel,
  pickOther,
  typeOther,
} from "../answer";
import { CheckIcon, StatusMark, TerminalIcon } from "../icons";
import { Spinner } from "../Spinner";

type Question = Extract<ChatPending, { kind: "question" }>;

// 人間の応答待ち。会話の末尾に 1 枚だけ置く。質問には選択肢か自由入力で答えられる。
// pi の ask_user は 1 問だけで、options が空なら自由入力だけになる。
// 承認は端末で行う（docs/adr/claude-integration.md / docs/adr/pi-integration.md）。
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
          <PendingHead state="承認待ち" who={pending.tool} />
          {pending.summary === null ? null : <p class="hwc-pending-text">{pending.summary}</p>}
          <p class="hwc-pending-note">端末で応答してください。</p>
        </>
      )}
      <button type="button" class="hwc-pending-toggle" onClick={props.onShowTerminal}>
        <TerminalIcon size={16} />
        端末出力を見る
      </button>
    </li>
  );
}

// 状態は記号と短文に集約する。面や枠を持たせず、見出しの強さを上げない。
function PendingHead(props: { state: string; who: string; count?: number }) {
  return (
    <p class="hwc-pending-head">
      <span class="hwc-pending-state">
        <span class="hwc-pending-state-mark">
          <StatusMark tone="attention" size={12} />
        </span>
        {props.state}
      </span>
      <span class="hwc-pending-who">{props.who}</span>
      {props.count === undefined ? null : (
        <span class="hwc-pending-count" aria-hidden="true">
          {props.count} 問
        </span>
      )}
    </p>
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
  const askUser = pending.tool === "ask_user";
  // Claude は今までどおり常に「その他」を出せる。pi は pending の freeText に従う。
  const freeText = pending.tool === "ask_user" ? pending.freeText : true;
  const question = pending.questions[0];
  const [choices, setChoices] = useState<Choice[]>(() =>
    // options が無い自由入力は「その他」を選ばせず、最初から入力欄を出す。
    freeText && question !== undefined && question.options.length === 0
      ? [{ ...NO_CHOICE, other: true }]
      : [],
  );
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
  const answers =
    askUser && question !== undefined
      ? askUserAnswers(question, choiceAt(0))
      : answersOf(pending.questions, choices);
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
      <PendingHead
        state="回答待ち"
        who={askUser ? "pi からの質問" : "Claude からの質問"}
        count={askUser ? undefined : pending.questions.length}
      />
      <ol class="hwc-pending-questions">
        {pending.questions.map((question, index) => {
          const choice = choiceAt(index);
          return (
            <li class="hwc-pending-question" key={index}>
              {question.header === null ? null : (
                <span class="hwc-pending-label-head">{question.header}</span>
              )}
              <p class="hwc-pending-text">{question.question}</p>
              {question.options.length === 0 ? null : (
                <ul class="hwc-pending-options">
                  {question.options.map((option, optionIndex) => (
                    <li key={optionIndex}>
                      <ChoiceButton
                        multi={question.multiSelect}
                        selected={choice.labels.includes(option.label)}
                        disabled={locked}
                        label={askOptionLabel(option.label, freeText)}
                        description={option.description}
                        onClick={() => update(index, pickLabel(question, choice, option.label))}
                      />
                    </li>
                  ))}
                  {freeText ? (
                    <li>
                      <ChoiceButton
                        multi={false}
                        selected={choice.other}
                        disabled={locked}
                        label={ASK_FREE_TEXT_LABEL}
                        description={null}
                        onClick={() => update(index, pickOther(choice))}
                      />
                      {choice.other ? (
                        <div class="hwc-pending-other-field">
                          <textarea
                            class="hwc-pending-other"
                            rows={2}
                            value={choice.text}
                            placeholder="回答を入力"
                            disabled={locked}
                            aria-label={`${question.question} の自由入力`}
                            onInput={(event) =>
                              update(index, typeOther(choice, event.currentTarget.value))
                            }
                          />
                        </div>
                      ) : null}
                    </li>
                  ) : null}
                </ul>
              )}
              {question.options.length === 0 && freeText && choice.other ? (
                <div class="hwc-pending-other-field">
                  <textarea
                    class="hwc-pending-other"
                    rows={2}
                    value={choice.text}
                    placeholder="回答を入力"
                    disabled={locked}
                    aria-label={`${question.question} の自由入力`}
                    onInput={(event) => update(index, typeOther(choice, event.currentTarget.value))}
                  />
                </div>
              ) : null}
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
          {askUser
            ? "回答を送りました。応答を待っています。"
            : "回答を送りました。Claude の応答を待っています。"}
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
