import { Check, FastForward, PaperPlaneTilt, Spinner } from '@phosphor-icons/react';
import type {
  ClarifyingQuestion,
  ClarifyingQuestionOption,
  PendingQuestions,
} from '@/lib/task-creation';
import { cn } from '@/lib/utils/cn';

// ============================================================================
// TYPES
// ============================================================================

interface QuestionsPanelProps {
  pendingQuestions: PendingQuestions;
  selectedAnswers: Record<string, string | string[]>;
  onSelectAnswer: (questionIndex: number, answer: string | string[]) => void;
  onSubmitAnswers: () => void;
  onSkip: () => void;
  isSubmitting: boolean;
}

// ============================================================================
// SUBCOMPONENTS
// ============================================================================

/**
 * Progress bar showing questions asked vs max
 */
function ProgressBar({
  totalAsked,
  maxQuestions,
}: {
  totalAsked: number;
  maxQuestions: number;
}): React.JSX.Element {
  // Cap displayed values at max to avoid showing "12 of 10"
  const displayedTotal = Math.min(totalAsked, maxQuestions);
  const percentage = Math.min((totalAsked / maxQuestions) * 100, 100);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-medium text-fg-muted">Clarifying Questions</span>
        <span className="text-fg-subtle">
          {displayedTotal} of {maxQuestions}
        </span>
      </div>
      <div className="h-1.5 bg-surface-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-claude rounded-full transition-all duration-300"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Single question card with options
 * Supports both single-select (radio) and multi-select (checkbox) modes
 */
function QuestionCard({
  question,
  selectedAnswer,
  onSelectAnswer,
}: {
  question: ClarifyingQuestion;
  selectedAnswer: string | string[] | undefined;
  onSelectAnswer: (answer: string | string[]) => void;
}): React.JSX.Element {
  const isMultiSelect = question.multiSelect ?? false;

  // Normalize selected values to array for easier checking
  const selectedValues: string[] = Array.isArray(selectedAnswer)
    ? selectedAnswer
    : selectedAnswer
      ? [selectedAnswer]
      : [];

  const handleOptionClick = (optionLabel: string) => {
    if (isMultiSelect) {
      // Toggle selection for multi-select
      const isCurrentlySelected = selectedValues.includes(optionLabel);
      if (isCurrentlySelected) {
        // Remove from selection
        onSelectAnswer(selectedValues.filter((v) => v !== optionLabel));
      } else {
        // Add to selection
        onSelectAnswer([...selectedValues, optionLabel]);
      }
    } else {
      // Single-select: just set the value
      onSelectAnswer(optionLabel);
    }
  };

  return (
    <div className="bg-surface border border-border rounded-lg p-3 space-y-2.5">
      {/* Header chip */}
      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 bg-claude/10 text-claude text-[10px] font-semibold rounded">
          {question.header}
        </span>
        {isMultiSelect && (
          <span className="px-1.5 py-0.5 bg-surface-muted text-fg-subtle text-[9px] font-medium rounded">
            Select multiple
          </span>
        )}
      </div>

      {/* Question text */}
      <p className="text-sm text-fg leading-relaxed">{question.question}</p>

      {/* Options */}
      <div className="space-y-1.5">
        {question.options.map((option: ClarifyingQuestionOption) => {
          const isSelected = selectedValues.includes(option.label);
          return (
            <button
              key={`${question.header}-${option.label}`}
              type="button"
              onClick={() => handleOptionClick(option.label)}
              className={cn(
                'w-full text-left px-3 py-2 rounded-lg border transition-all',
                isSelected
                  ? 'bg-claude/10 border-claude text-fg'
                  : 'bg-surface-subtle border-border text-fg-muted hover:bg-surface-muted hover:text-fg'
              )}
            >
              <div className="flex items-start gap-2">
                <div
                  className={cn(
                    'mt-0.5 w-4 h-4 border-2 flex items-center justify-center shrink-0',
                    // Checkbox (rounded) for multi-select, radio (rounded-full) for single-select
                    isMultiSelect ? 'rounded' : 'rounded-full',
                    isSelected ? 'border-claude bg-claude' : 'border-border'
                  )}
                >
                  {isSelected && <Check className="w-2.5 h-2.5 text-white" weight="bold" />}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium block">{option.label}</span>
                  {option.description && (
                    <span className="text-[11px] text-fg-muted block mt-0.5">
                      {option.description}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function QuestionsPanel({
  pendingQuestions,
  selectedAnswers,
  onSelectAnswer,
  onSubmitAnswers,
  onSkip,
  isSubmitting,
}: QuestionsPanelProps): React.JSX.Element {
  // Validate that answers match the current questions' options
  // This prevents stale answers from previous rounds from being used
  const validateAnswer = (
    question: ClarifyingQuestion,
    answer: string | string[] | undefined
  ): boolean => {
    if (answer === undefined) return false;

    const validLabels = question.options.map((o) => o.label);

    if (question.multiSelect) {
      // Multi-select: all selected values must be valid options
      if (!Array.isArray(answer) || answer.length === 0) return false;
      return answer.every((a) => validLabels.includes(a));
    }
    // Single-select: value must be a valid option
    return typeof answer === 'string' && validLabels.includes(answer);
  };

  // Check if all questions are answered with VALID options for the current questions
  // This guards against race conditions where old answers from previous rounds
  // might still be in state when new questions arrive
  const allAnswered = pendingQuestions.questions.every(
    (question: ClarifyingQuestion, index: number) => {
      const answer = selectedAnswers[String(index)];
      return validateAnswer(question, answer);
    }
  );

  // DEBUG: Log which questions are answered
  console.log('[QuestionsPanel] Answer check:', {
    totalQuestions: pendingQuestions.questions.length,
    selectedAnswers,
    allAnswered,
    questionStatus: pendingQuestions.questions.map((q, i) => ({
      index: i,
      header: q.header,
      multiSelect: q.multiSelect,
      answer: selectedAnswers[String(i)],
      isAnswered:
        selectedAnswers[String(i)] !== undefined &&
        (q.multiSelect
          ? Array.isArray(selectedAnswers[String(i)]) &&
            (selectedAnswers[String(i)] as string[]).length > 0
          : typeof selectedAnswers[String(i)] === 'string' &&
            (selectedAnswers[String(i)] as string).length > 0),
    })),
  });

  return (
    <div className="flex flex-col h-full bg-gradient-to-br from-surface via-surface to-claude/[0.02]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-claude/20 bg-claude/5">
        <div className="flex items-center gap-2">
          <svg
            viewBox="0 0 248 248"
            fill="currentColor"
            className="h-4 w-4 text-claude"
            aria-hidden="true"
          >
            <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
          </svg>
          <div>
            <h3 className="text-sm font-semibold text-fg">Claude has questions</h3>
            <p className="text-[10px] text-fg-muted">
              Round {pendingQuestions.round} - Answer to refine your task
            </p>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="px-4 py-2 border-b border-border bg-surface/50">
        <ProgressBar
          totalAsked={pendingQuestions.totalAsked}
          maxQuestions={pendingQuestions.maxQuestions}
        />
      </div>

      {/* Questions list - flex-1 to fill space, min-h-0 for proper scrolling */}
      <div className="flex-1 min-h-0 p-4 space-y-3 overflow-y-auto">
        {pendingQuestions.questions.map((question: ClarifyingQuestion, index: number) => (
          <QuestionCard
            key={`${pendingQuestions.id}-${index}`}
            question={question}
            selectedAnswer={selectedAnswers[String(index)]}
            onSelectAnswer={(answer) => onSelectAnswer(index, answer)}
          />
        ))}
      </div>

      {/* Actions footer - shrink-0 to prevent compression */}
      <div className="shrink-0 px-4 py-3 border-t border-border bg-surface flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onSkip}
          disabled={isSubmitting}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors',
            isSubmitting && !allAnswered
              ? 'text-fg-muted border border-border cursor-wait opacity-70'
              : 'text-fg-muted hover:text-fg border border-border hover:bg-surface-muted',
            'disabled:cursor-not-allowed'
          )}
        >
          {isSubmitting && !allAnswered ? (
            <Spinner className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FastForward className="h-3.5 w-3.5" />
          )}
          {isSubmitting && !allAnswered ? 'Skipping...' : 'Skip Questions'}
        </button>

        <button
          type="button"
          onClick={onSubmitAnswers}
          disabled={!allAnswered || isSubmitting}
          aria-busy={isSubmitting}
          className={cn(
            'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-all',
            isSubmitting
              ? 'bg-claude text-white shadow-sm cursor-wait opacity-90'
              : allAnswered
                ? 'bg-claude text-white hover:bg-claude/90 shadow-sm'
                : 'bg-surface-muted text-fg-subtle cursor-not-allowed'
          )}
        >
          {isSubmitting ? (
            <>
              <Spinner className="h-4 w-4 animate-spin" />
              Submitting...
            </>
          ) : (
            <>
              <PaperPlaneTilt className="h-4 w-4" weight="fill" />
              Submit Answers
            </>
          )}
        </button>
      </div>
    </div>
  );
}
