import {
  ArrowRight,
  ArrowUp,
  Book,
  CaretDown,
  CaretUp,
  Check,
  CheckCircle,
  CircleNotch,
  Code,
  Cube,
  Eraser,
  MagnifyingGlass,
  Stack,
  TreeStructure,
  WarningCircle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClarifyingQuestion,
  ComposeMessage,
  ComposeMode,
  ComposeStage,
  ModuleMatch,
} from '@/lib/terraform/types';
import { COMPOSE_STAGE_LABELS, PROVIDER_COLORS } from '@/lib/terraform/types';
import { cn } from '@/lib/utils/cn';
import { useTerraform } from './terraform-context';

const QUICK_START_PROMPTS = [
  {
    icon: 'stack' as const,
    text: 'VPC with security groups, ALB, and EC2 instances for a web app',
  },
  {
    icon: 'cube' as const,
    text: 'S3 bucket with CloudFront distribution and Route53 DNS for static hosting',
  },
  {
    icon: 'stack' as const,
    text: 'Lambda function with SQS queue, SNS topic, and CloudWatch alarms',
  },
  { icon: 'cube' as const, text: 'EC2 instances with autoscaling, ALB, and DynamoDB backend' },
  {
    icon: 'stack' as const,
    text: 'VPC with KMS encryption, IAM roles, and S3 bucket for a secure data pipeline',
  },
  {
    icon: 'cube' as const,
    text: 'Landing zone with VPC, security groups, IAM, and CloudWatch monitoring',
  },
];

function PromptIcon({ type, className }: { type: 'stack' | 'cube'; className?: string }) {
  return type === 'stack' ? (
    <Stack className={className ?? 'h-3.5 w-3.5'} />
  ) : (
    <Cube className={className ?? 'h-3.5 w-3.5'} />
  );
}

function InlineModuleMatches({ modules }: { modules: ModuleMatch[] }) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {modules.map((mod) => (
        <div
          key={mod.moduleId}
          className="flex flex-col gap-1 rounded border border-border-muted bg-surface-subtle px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${mod.confidence >= 0.8 ? 'bg-success' : 'bg-attention'}`}
            />
            <span className="font-mono font-medium text-fg">{mod.name}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${PROVIDER_COLORS[mod.provider.toLowerCase()] ?? 'bg-surface-emphasis text-fg-muted'}`}
            >
              {mod.provider}
            </span>
            {mod.version && <span className="text-[11px] text-fg-subtle">v{mod.version}</span>}
          </div>
          <span className="font-mono text-[11px] text-fg-muted pl-4">{mod.source}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Collapsible text for long assistant responses.
 * Shows first paragraph with a toggle to expand/collapse the rest.
 */
function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  // Split on double newline to get first paragraph
  const splitIdx = text.indexOf('\n\n');
  const hasMore = splitIdx > 0 && splitIdx < text.length - 2;
  const firstParagraph = hasMore ? text.slice(0, splitIdx) : text;

  if (!hasMore) {
    return <div className="whitespace-pre-wrap break-words">{text}</div>;
  }

  return (
    <div>
      <div className="whitespace-pre-wrap break-words">{expanded ? text : firstParagraph}</div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="mt-1 flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg transition-colors"
      >
        {expanded ? (
          <>
            <CaretUp className="h-3 w-3" /> Show less
          </>
        ) : (
          <>
            <CaretDown className="h-3 w-3" /> Show more
          </>
        )}
      </button>
    </div>
  );
}

/** Map well-known clarifying question categories to accent color classes. */
const CATEGORY_COLORS: Record<string, string> = {
  domain: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  dns: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  region: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  zone: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  security: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  iam: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  networking: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  storage: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

const categoryColorCache = new Map<string, string>();

function getCategoryColor(category: string): string {
  const cached = categoryColorCache.get(category);
  if (cached) return cached;
  const key = category.toLowerCase();
  for (const [k, v] of Object.entries(CATEGORY_COLORS)) {
    if (key.includes(k)) {
      categoryColorCache.set(category, v);
      return v;
    }
  }
  const fallback = 'bg-surface-emphasis text-fg-muted';
  categoryColorCache.set(category, fallback);
  return fallback;
}

const HCL_BLOCK_RE = /```(?:hcl|terraform|tf)[\s\S]*?```/g;
const QUESTION_LINE_RE = /^\s*(?:\d+[.)]\s*|-\s*|\*\s*)\*?\*?/m;

/**
 * Strip content from an assistant message for display.
 * - Always removes HCL code blocks (shown in the code panel instead).
 * - When clarifying questions are present, strips numbered/bulleted question lines
 *   so only the introductory text remains (questions are shown in ClarifyingQuestionsUI).
 */
function stripAssistantContent(msg: ComposeMessage): string {
  let text = msg.content.replace(HCL_BLOCK_RE, '').trim();

  if (msg.clarifyingQuestions && msg.clarifyingQuestions.length > 0) {
    // Keep only the introductory text before the first numbered/bulleted question.
    // This avoids issues with multi-line questions or trailing parenthetical text.
    const firstQuestionIdx = text.search(QUESTION_LINE_RE);
    if (firstQuestionIdx > 0) {
      text = text.slice(0, firstQuestionIdx).trim();
    }
  }

  return text;
}

function ClarifyingQuestionsUI({
  questions,
  onSubmit,
  onSkip,
}: {
  questions: ClarifyingQuestion[];
  round?: number;
  totalRounds?: number;
  onSubmit: (answers: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customMode, setCustomMode] = useState<Record<string, boolean>>({});

  const answeredCount = useMemo(
    () => questions.filter((q) => answers[q.question]?.trim()).length,
    [questions, answers]
  );
  const allAnswered = answeredCount === questions.length;

  return (
    <div className="mt-3 rounded-lg border border-accent/20 bg-accent-muted/30 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
        <span className="text-xs font-semibold text-fg">
          {questions.length} question{questions.length > 1 ? 's' : ''} to refine your configuration
        </span>
        <button type="button" onClick={onSkip} className="text-xs text-fg-muted hover:text-fg">
          Use defaults
        </button>
      </div>

      {/* Questions */}
      <div>
        {questions.map((q, idx) => (
          <div key={q.question} className={cn('px-4 py-3', idx > 0 && 'border-t border-border/30')}>
            {/* Question header with step number */}
            <div className="flex items-start gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                {idx + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {q.category !== 'General' && (
                    <span
                      className={cn(
                        'rounded-md px-2 py-0.5 text-[11px] font-semibold',
                        getCategoryColor(q.category)
                      )}
                    >
                      {q.category}
                    </span>
                  )}
                  <div className="text-[13px] font-medium text-fg">{q.question}</div>
                </div>

                {/* Options or custom input */}
                <div className="mt-2">
                  {customMode[q.question] ? (
                    <div className="flex gap-1.5 items-center">
                      <input
                        type="text"
                        value={answers[q.question] ?? ''}
                        onChange={(e) =>
                          setAnswers((prev) => ({ ...prev, [q.question]: e.target.value }))
                        }
                        placeholder="Type your answer..."
                        className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-subtle outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
                        // biome-ignore lint/a11y/noAutofocus: intentional focus on custom input expansion
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (answers[q.question]?.trim()) {
                            // Confirm custom answer — just close custom mode, keep the value
                            setCustomMode((prev) => ({ ...prev, [q.question]: false }));
                          }
                        }}
                        disabled={!answers[q.question]?.trim()}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-white disabled:opacity-40"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCustomMode((prev) => ({ ...prev, [q.question]: false }));
                          setAnswers((prev) => {
                            const next = { ...prev };
                            delete next[q.question];
                            return next;
                          });
                        }}
                        className="text-xs text-fg-muted hover:text-fg px-1"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {q.options.map((opt) => {
                        const isDefault = opt.startsWith('Use default:');
                        const defaultValue = isDefault ? opt.slice('Use default:'.length) : null;
                        const displayLabel = isDefault ? 'Use default' : opt;
                        const answerValue = defaultValue ?? opt;
                        const isSelected = answers[q.question] === answerValue;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() =>
                              setAnswers((prev) => {
                                if (prev[q.question] === answerValue) {
                                  const next = { ...prev };
                                  delete next[q.question];
                                  return next;
                                }
                                return { ...prev, [q.question]: answerValue };
                              })
                            }
                            className={cn(
                              'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] transition-colors',
                              isSelected
                                ? 'border-accent bg-accent/15 text-accent'
                                : 'border-border bg-surface text-fg-muted hover:border-accent hover:text-accent'
                            )}
                          >
                            {isSelected && <Check className="h-3 w-3 shrink-0" weight="bold" />}
                            <span className="flex flex-col items-start">
                              <span>{displayLabel}</span>
                              {defaultValue && (
                                <span className="text-[10px] font-mono opacity-70">
                                  {defaultValue}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                      {/* Show custom answer as a selected pill when not in custom mode */}
                      {answers[q.question] &&
                        !q.options.includes(answers[q.question] as string) && (
                          <button
                            type="button"
                            onClick={() =>
                              setCustomMode((prev) => ({ ...prev, [q.question]: true }))
                            }
                            className="flex items-center gap-1.5 rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-[13px] text-accent"
                          >
                            <Check className="h-3 w-3 shrink-0" weight="bold" />
                            {answers[q.question]}
                          </button>
                        )}
                      <button
                        type="button"
                        onClick={() => setCustomMode((prev) => ({ ...prev, [q.question]: true }))}
                        className="rounded-md border border-dashed border-border px-3 py-1.5 text-[13px] text-fg-subtle transition-colors hover:border-accent hover:text-accent"
                      >
                        Other...
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border/30 px-4 py-3 bg-surface/30">
        <span className="text-xs text-fg-muted">
          {answeredCount} of {questions.length} answered
        </span>
        <button
          type="button"
          onClick={() => onSubmit(answers)}
          disabled={!allAnswered}
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40 transition-colors"
        >
          Submit Answers
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function SuccessBanner({
  moduleCount,
  variableCount,
  outputCount,
}: {
  moduleCount: number;
  variableCount: number;
  outputCount: number;
}) {
  return (
    <div className="mt-3 rounded-md border border-success/30 bg-success-muted p-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-success">
        <Check className="h-3.5 w-3.5" />
        Configuration generated
      </div>
      <div className="mt-1 text-xs text-fg-muted">
        {moduleCount} modules &middot; {variableCount} variables configured &middot; {outputCount}{' '}
        outputs
      </div>
    </div>
  );
}

const COMPOSE_STAGES: ComposeStage[] = [
  'loading_catalog',
  'analyzing',
  'matching_modules',
  'generating_code',
  'validating_hcl',
  'finalizing',
];

const STAGE_ICONS: Record<ComposeStage, React.ElementType> = {
  loading_catalog: Book,
  analyzing: TreeStructure,
  matching_modules: MagnifyingGlass,
  generating_code: Code,
  validating_hcl: CheckCircle,
  finalizing: Check,
};

function ComposeProgress({
  currentStage,
  matchedModules,
  isComplete,
}: {
  currentStage: ComposeStage;
  matchedModules: ModuleMatch[];
  isComplete: boolean;
}) {
  const currentIdx = COMPOSE_STAGES.indexOf(currentStage);

  return (
    <div className="flex gap-3 animate-slide-up">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-done-muted text-[11px] font-semibold text-done">
        AI
      </div>
      <div className="max-w-[85%] rounded-xl border border-border bg-surface px-4 py-3">
        {isComplete && (
          <div className="mb-3 text-sm font-semibold text-success">
            {'\u{1F389}'} Configuration Ready
          </div>
        )}
        <div className="space-y-2">
          {COMPOSE_STAGES.map((stage, idx) => {
            const Icon = STAGE_ICONS[stage];
            const isActive = !isComplete && idx === currentIdx;
            const isDone = isComplete || idx < currentIdx;
            const isPending = !isComplete && idx > currentIdx;

            return (
              <div
                key={stage}
                className={`flex items-center gap-2.5 text-xs transition-all ${
                  isPending ? 'opacity-30' : 'opacity-100'
                }`}
              >
                {isDone ? (
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[13px]">
                    {'\u2705'}
                  </span>
                ) : isActive ? (
                  <CircleNotch className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                ) : (
                  <Icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                )}
                <span
                  className={
                    isActive ? 'font-medium text-fg' : isDone ? 'text-fg-muted' : 'text-fg-subtle'
                  }
                >
                  {COMPOSE_STAGE_LABELS[stage]}
                </span>
              </div>
            );
          })}
        </div>

        {/* Show matched modules inline */}
        {matchedModules.length > 0 &&
          (isComplete || currentIdx >= COMPOSE_STAGES.indexOf('matching_modules')) && (
            <div className="mt-3 border-t border-border-muted pt-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                Matched Modules
              </div>
              <div className="space-y-1">
                {matchedModules.map((mod) => (
                  <div
                    key={mod.moduleId}
                    className="flex items-center gap-2 text-xs animate-slide-up"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        mod.confidence >= 0.8 ? 'bg-success' : 'bg-attention'
                      }`}
                    />
                    <span className="font-mono font-medium text-fg">{mod.name}</span>
                    <span
                      className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                        PROVIDER_COLORS[mod.provider.toLowerCase()] ??
                        'bg-surface-emphasis text-fg-muted'
                      }`}
                    >
                      {mod.provider}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
      </div>
    </div>
  );
}

function ErrorBubble({
  error,
  onDismiss,
}: {
  error: string;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="flex gap-3 animate-slide-up">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger-muted text-[11px] font-semibold text-danger">
        <WarningCircle className="h-4 w-4" weight="bold" />
      </div>
      <div className="max-w-[85%] rounded-xl border border-danger/20 bg-danger-muted/50 px-4 py-2.5 text-sm text-fg">
        <p>{error}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 text-xs text-fg-muted hover:text-fg underline"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

interface ChatInputProps {
  input: string;
  setInput: (v: string) => void;
  isStreaming: boolean;
  composeMode: ComposeMode;
  setComposeMode: (mode: ComposeMode) => void;
  onSubmit: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

function ChatInput({
  input,
  setInput,
  isStreaming,
  composeMode,
  setComposeMode,
  onSubmit,
  onKeyDown,
  inputRef,
}: ChatInputProps): React.JSX.Element {
  return (
    <div className="border-t border-border bg-surface px-6 py-4">
      <div className="rounded-xl border border-border bg-canvas p-3 focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/15">
        {/* Mode chips */}
        <div className="mb-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setComposeMode(composeMode === 'stacks' ? 'terraform' : 'stacks')}
            disabled={isStreaming}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
              composeMode === 'stacks'
                ? 'border-[#844fba] bg-[#844fba]/10 text-[#844fba]'
                : 'border-border text-fg-muted opacity-60 hover:opacity-100 hover:border-[#844fba]/50 hover:text-[#844fba]/70',
              isStreaming && 'pointer-events-none opacity-40'
            )}
          >
            <Stack className="h-3 w-3" />
            Stacks
          </button>
        </div>
        <div className="flex items-end gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              composeMode === 'stacks'
                ? 'Describe your multi-environment infrastructure...'
                : 'Describe your infrastructure needs...'
            }
            rows={6}
            className="flex-1 resize-none bg-transparent text-sm leading-relaxed text-fg placeholder:text-fg-subtle outline-none"
            disabled={isStreaming}
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!input.trim() || isStreaming}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#1f6feb] text-white transition-colors hover:bg-[#1f6feb]/90 disabled:opacity-50"
            aria-label="Send message"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function TerraformChatPanel(): React.JSX.Element {
  const {
    messages,
    isStreaming,
    composeStage,
    composeComplete,
    matchedModules,
    generatedCode,
    error,
    composeMode,
    setComposeMode,
    sendMessage,
    resetConversation,
    clearError,
  } = useTerraform();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when messages or compose stage change
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll must trigger on message/stage changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, composeStage, composeComplete, matchedModules]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput('');
    await sendMessage(trimmed);
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  // Welcome state
  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-auto px-8 animate-fade-in">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[rgba(132,79,186,0.15)] shadow-[0_0_24px_rgba(132,79,186,0.15)]">
            {composeMode === 'stacks' ? (
              <Stack className="h-8 w-8 text-[#844fba]" weight="duotone" />
            ) : (
              <Cube className="h-8 w-8 text-[#844fba]" weight="duotone" />
            )}
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold tracking-tight text-fg">
              {composeMode === 'stacks' ? 'Compose Stacks' : 'Compose Infrastructure'}
            </h2>
            <p className="mt-1 max-w-md text-sm text-fg-muted">
              {composeMode === 'stacks'
                ? 'Describe your multi-environment infrastructure. We\u2019ll generate Terraform Stacks with components and deployments.'
                : 'Describe what you need in plain English. We\u2019ll match your requirements to private modules and compose the Terraform configuration.'}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {QUICK_START_PROMPTS.map((prompt) => (
              <button
                key={prompt.text}
                type="button"
                onClick={() => void sendMessage(prompt.text)}
                className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg-muted transition-all hover:border-accent hover:text-accent hover:bg-accent-muted"
              >
                <PromptIcon type={prompt.icon} className="h-3 w-3" />
                {prompt.text}
              </button>
            ))}
          </div>
        </div>
        <ChatInput
          input={input}
          setInput={setInput}
          isStreaming={isStreaming}
          composeMode={composeMode}
          setComposeMode={setComposeMode}
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
          inputRef={inputRef}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.map((msg, idx) => (
            <div
              key={`${msg.role}-${idx}`}
              className={`flex gap-3 animate-slide-up ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
            >
              {/* Avatar */}
              {msg.role === 'user' ? (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-muted text-[11px] font-semibold text-accent">
                  SL
                </div>
              ) : (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-done-muted text-[11px] font-semibold text-done">
                  AI
                </div>
              )}
              {/* Bubble */}
              <div
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${
                  msg.role === 'user'
                    ? 'bg-[#1f6feb] text-white'
                    : 'border border-border bg-surface text-fg'
                }`}
              >
                {msg.role === 'assistant' ? (
                  <CollapsibleText text={stripAssistantContent(msg)} />
                ) : (
                  <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                )}
                {msg.role === 'assistant' && msg.modules && msg.modules.length > 0 && (
                  <InlineModuleMatches modules={msg.modules} />
                )}
                {msg.role === 'assistant' &&
                  msg.clarifyingQuestions &&
                  msg.clarifyingQuestions.length > 0 && (
                    <ClarifyingQuestionsUI
                      questions={msg.clarifyingQuestions}
                      round={1}
                      totalRounds={1}
                      onSubmit={(answers) => {
                        const answerText = Object.entries(answers)
                          .map(([q, a]) => `${q}: ${a}`)
                          .join('\n');
                        void sendMessage(answerText);
                      }}
                      onSkip={() => void sendMessage('Skip clarifying questions')}
                    />
                  )}
                {msg.role === 'assistant' && msg.successBanner && (
                  <SuccessBanner
                    moduleCount={msg.successBanner.moduleCount}
                    variableCount={msg.successBanner.variableCount}
                    outputCount={msg.successBanner.outputCount}
                  />
                )}
              </div>
            </div>
          ))}
          {((isStreaming && composeStage) ||
            (composeComplete && composeStage && generatedCode)) && (
            <ComposeProgress
              currentStage={composeStage}
              matchedModules={matchedModules}
              isComplete={composeComplete}
            />
          )}
          {error && !isStreaming && <ErrorBubble error={error} onDismiss={clearError} />}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="flex items-center gap-2 px-2">
        <button
          type="button"
          onClick={resetConversation}
          className="rounded-md p-2 text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
          title="New conversation"
          aria-label="New conversation"
        >
          <Eraser className="h-4 w-4" />
        </button>
        <div className="flex-1">
          <ChatInput
            input={input}
            setInput={setInput}
            isStreaming={isStreaming}
            composeMode={composeMode}
            setComposeMode={setComposeMode}
            onSubmit={handleSubmit}
            onKeyDown={handleKeyDown}
            inputRef={inputRef}
          />
        </div>
      </div>
    </div>
  );
}
