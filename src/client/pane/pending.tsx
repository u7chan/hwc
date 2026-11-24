import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatPending, ChatPendingQuestion } from "../../server/chat/contract";
import type { QuestionAnswer } from "../../shared/answer";
import type { AnswerResult } from "../api";
import {
  answerFailure,
  answersOf,
  answerSummary,
  ASK_FREE_TEXT_LABEL,
  askOptionLabelsForQuestions,
  askUserAnswers,
  type Choice,
  isAnswered,
  NO_CHOICE,
  nextPage,
  pickLabel,
  pickOther,
  questionLabel,
  typeOther,
  unansweredIndexes,
} from "../answer";
import { CheckIcon, ChevronRightIcon, StatusMark, TerminalIcon } from "../icons";
import { enterInsertsNewline, enterSubmits } from "../input";
import { Spinner } from "../Spinner";

type Question = Extract<ChatPending, { kind: "question" }>;

// 単一選択の印が見えてから次のページへ進むまでの待ち。
const ADVANCE_MS = 260;

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
      <div class="hwc-pending-band">
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
      </div>
      <button type="button" class="hwc-pending-toggle" onClick={props.onShowTerminal}>
        <TerminalIcon size={16} />
        端末出力を見る
      </button>
    </li>
  );
}

// 状態は記号と短文に集約する。見出しの強さを上げない。
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
  const { questions } = pending;
  const askUser = pending.tool === "ask_user";
  // Claude は今までどおり常に「その他」を出せる。pi は pending の freeText に従う。
  const freeText = pending.tool === "ask_user" ? pending.freeText : true;
  const first = questions[0];
  const optionLabels = askOptionLabelsForQuestions(questions, freeText);
  // 質問が 2 つ以上のときだけ、1 問ずつのページにする。pi の ask_user は常に 1 問。
  // 質問の数番目のページが、答えを見直す確認ページ。
  const paged = questions.length > 1;
  const [choices, setChoices] = useState<Choice[]>(() =>
    // options が無い自由入力は「その他」を選ばせず、最初から入力欄を出す。
    freeText && first !== undefined && first.options.length === 0
      ? [{ ...NO_CHOICE, other: true }]
      : [],
  );
  const [page, setPage] = useState(0);
  const [phase, setPhase] = useState<Phase>("editing");
  const [failure, setFailure] = useState<string | null>(null);

  const choiceAt = (index: number): Choice => choices[index] ?? NO_CHOICE;
  const withChoice = (index: number, next: Choice): Choice[] => {
    const copy = [...choices];
    copy[index] = next;
    return copy;
  };
  const update = (index: number, next: Choice) => {
    setFailure(null);
    setChoices((current) => {
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
  };
  const pick = (index: number, label: string) => {
    const question = questions[index];
    if (question === undefined) return;
    const next = pickLabel(question, choiceAt(index), label);
    update(index, next);
    // 複数選択は選び終わりが分からないので、自動では進めない。
    if (!paged || question.multiSelect) return;
    const to = nextPage(questions, withChoice(index, next), index);
    // 待つ間に別のページへ移っていたら、そのページを動かさない。
    window.setTimeout(() => setPage((current) => (current === index ? to : current)), ADVANCE_MS);
  };

  // 答えが揃っているかは、選択から毎回導く。
  const answers =
    askUser && first !== undefined
      ? askUserAnswers(first, choiceAt(0))
      : answersOf(questions, choices);
  const unanswered = paged ? unansweredIndexes(questions, choices) : [];
  const locked = phase !== "editing";
  const reviewing = paged && page === questions.length;
  const current = questions[page];
  // 「次へ」も自動送りと同じ行き先にする。全問に答えてある（確認から直しに来た）ときは確認へ戻る。
  const next = nextPage(questions, choices, page);

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

  // Enter はページの主ボタンに合わせる。有効かどうかの判断はボタンと同じ条件に任せる。
  const pressPrimary = () => {
    if (locked) return;
    if (!paged || reviewing) {
      void submit();
      return;
    }
    if (current === undefined || !isAnswered(current, choiceAt(page))) return;
    setPage(next);
  };

  return (
    <>
      <PendingHead
        state="回答待ち"
        who={askUser ? "pi からの質問" : "Claude からの質問"}
        count={askUser || paged ? undefined : questions.length}
      />
      {paged ? (
        <QuestionTabs
          questions={questions}
          choices={choices}
          page={page}
          locked={locked}
          onGo={setPage}
        />
      ) : null}
      {/* ページごとに作り直し、切り替わりを短いフェードで見せる。 */}
      <div class="hwc-pending-page" key={page} role={paged ? "tabpanel" : undefined}>
        {reviewing ? (
          <ReviewPage questions={questions} choices={choices} locked={locked} onGo={setPage} />
        ) : current === undefined ? null : (
          <QuestionFields
            question={current}
            choice={choiceAt(page)}
            optionLabels={optionLabels[page] ?? []}
            freeText={freeText}
            // ページのときは見出しがタブに出ているので、本文では繰り返さない。
            showHeader={!paged}
            locked={locked}
            onPick={(label) => pick(page, label)}
            onOther={() => update(page, pickOther(choiceAt(page)))}
            onType={(text) => update(page, typeOther(choiceAt(page), text))}
            onSubmitKey={pressPrimary}
          />
        )}
      </div>
      <div class="hwc-pending-foot" data-solo={!paged || page === 0 ? "true" : undefined}>
        {paged && page > 0 ? (
          <button
            type="button"
            class="hwc-dialog-button hwc-dialog-cancel"
            disabled={locked}
            onClick={() => setPage(page - 1)}
          >
            戻る
          </button>
        ) : null}
        {paged && !reviewing ? (
          <button
            type="button"
            class="hwc-dialog-button hwc-dialog-primary"
            disabled={locked || current === undefined || !isAnswered(current, choiceAt(page))}
            onClick={() => setPage(next)}
          >
            {next === questions.length ? "確認へ" : "次へ"}
          </button>
        ) : (
          <button
            type="button"
            class="hwc-dialog-button hwc-dialog-primary"
            disabled={answers === null || locked}
            onClick={() => void submit()}
          >
            {phase === "sending" ? <Spinner /> : null}
            この内容で答える
          </button>
        )}
      </div>
      {phase === "sent" ? (
        <p class="hwc-pending-note" role="status">
          {askUser
            ? "回答を送りました。応答を待っています。"
            : "回答を送りました。Claude の応答を待っています。"}
        </p>
      ) : failure !== null ? (
        <p class="hwc-pending-error" role="status">
          <StatusMark tone="attention" size={12} />
          {failure}
        </p>
      ) : reviewing && unanswered.length > 0 ? (
        <p class="hwc-pending-error" role="status">
          <StatusMark tone="attention" size={12} />
          未回答が {unanswered.length} 問あります
        </p>
      ) : null}
    </>
  );
}

// 質問ごとのタブと、最後の確認。幅が足りないので、見出しは開いているタブだけに出し、
// ほかは番号か回答済みのチェックだけにする。確認は終点なので常に名前を出す。
function QuestionTabs(props: {
  questions: readonly ChatPendingQuestion[];
  choices: readonly Choice[];
  page: number;
  locked: boolean;
  onGo: (page: number) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // 開いているタブを帯の中央へ寄せる。scrollIntoView は会話のスクロールまで動かし得る。
  useEffect(() => {
    const element = strip.current;
    if (element === null) return;
    const tab = element.querySelector<HTMLElement>('[aria-selected="true"]');
    if (tab === null) return;
    element.scrollLeft = tab.offsetLeft - (element.clientWidth - tab.offsetWidth) / 2;
  }, [props.page]);

  const count = props.questions.length;
  const allAnswered = unansweredIndexes(props.questions, props.choices).length === 0;
  return (
    <div class="hwc-pending-tabs" role="tablist" aria-label="質問" ref={strip}>
      {props.questions.map((question, index) => {
        const done = isAnswered(question, props.choices[index] ?? NO_CHOICE);
        const open = props.page === index;
        const label = questionLabel(question, index);
        return (
          <button
            type="button"
            role="tab"
            class="hwc-pending-tab"
            key={index}
            aria-selected={open}
            aria-label={label}
            data-done={done}
            disabled={props.locked}
            onClick={() => props.onGo(index)}
          >
            <span class="hwc-pending-tab-mark" aria-hidden="true">
              {done ? <CheckIcon size={11} /> : index + 1}
            </span>
            {open ? label : null}
          </button>
        );
      })}
      <button
        type="button"
        role="tab"
        class="hwc-pending-tab"
        aria-selected={props.page === count}
        data-done={allAnswered}
        disabled={props.locked}
        onClick={() => props.onGo(count)}
      >
        <span class="hwc-pending-tab-mark" aria-hidden="true">
          {allAnswered ? <CheckIcon size={11} /> : <ChevronRightIcon size={11} />}
        </span>
        確認
      </button>
    </div>
  );
}

// 答えの一覧。行を押すと、その質問のページへ戻って直せる。
function ReviewPage(props: {
  questions: readonly ChatPendingQuestion[];
  choices: readonly Choice[];
  locked: boolean;
  onGo: (page: number) => void;
}) {
  return (
    <>
      <p class="hwc-pending-text">この内容で答えますか？</p>
      <ul class="hwc-pending-review">
        {props.questions.map((question, index) => {
          const summary = answerSummary(question, props.choices[index] ?? NO_CHOICE);
          return (
            <li key={index}>
              <button
                type="button"
                class="hwc-pending-review-row"
                disabled={props.locked}
                onClick={() => props.onGo(index)}
              >
                <span class="hwc-pending-review-text">
                  <span class="hwc-pending-review-head">{questionLabel(question, index)}</span>
                  {summary === null ? (
                    <span class="hwc-pending-review-answer" data-empty="true">
                      <StatusMark tone="attention" size={12} />
                      未回答
                    </span>
                  ) : (
                    <span class="hwc-pending-review-answer">{summary}</span>
                  )}
                </span>
                <ChevronRightIcon size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function QuestionFields(props: {
  question: ChatPendingQuestion;
  choice: Choice;
  optionLabels: readonly string[];
  freeText: boolean;
  showHeader: boolean;
  locked: boolean;
  onPick: (label: string) => void;
  onOther: () => void;
  onType: (text: string) => void;
  onSubmitKey: () => void;
}) {
  const { question, choice, locked } = props;
  const otherField = (
    <div class="hwc-pending-other-field">
      <textarea
        class="hwc-pending-other"
        rows={2}
        value={choice.text}
        placeholder="回答を入力"
        disabled={locked}
        aria-label={`${question.question} の自由入力`}
        onInput={(event) => props.onType(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // タッチ端末は改行のまま。物理キーボードのある端末でだけ、本文の入力欄と同じく
          // Enter を主ボタンに重ねる。
          const match = (query: string) => window.matchMedia(query).matches;
          if (!enterSubmits(event, enterInsertsNewline(match))) return;
          event.preventDefault();
          props.onSubmitKey();
        }}
      />
    </div>
  );
  return (
    <div class="hwc-pending-question">
      {props.showHeader && question.header !== null ? (
        <span class="hwc-pending-label-head">{question.header}</span>
      ) : null}
      <p class="hwc-pending-text">{question.question}</p>
      {question.options.length === 0 ? null : (
        <ul class="hwc-pending-options">
          {question.options.map((option, optionIndex) => (
            <li key={optionIndex}>
              <ChoiceButton
                multi={question.multiSelect}
                selected={choice.labels.includes(option.label)}
                disabled={locked}
                label={props.optionLabels[optionIndex] ?? option.label}
                description={option.description}
                onClick={() => props.onPick(option.label)}
              />
            </li>
          ))}
          {props.freeText ? (
            <li>
              <ChoiceButton
                multi={false}
                selected={choice.other}
                disabled={locked}
                label={ASK_FREE_TEXT_LABEL}
                description={null}
                onClick={props.onOther}
              />
              {choice.other ? otherField : null}
            </li>
          ) : null}
        </ul>
      )}
      {question.options.length === 0 && props.freeText && choice.other ? otherField : null}
      {question.multiSelect ? <p class="hwc-pending-note">複数選べます</p> : null}
    </div>
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
