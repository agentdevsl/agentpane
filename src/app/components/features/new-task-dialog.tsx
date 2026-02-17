import {
  ArrowRight,
  ArrowsOutCardinal,
  Check,
  PaperPlaneTilt,
  Plus,
  Spinner,
  User,
  Warning,
  X,
} from '@phosphor-icons/react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api/client';
import {
  type TaskCreationMessage,
  type TaskSuggestion,
  useTaskCreation,
} from '@/lib/task-creation';
import { cn } from '@/lib/utils/cn';
import { getLabelColors, type Priority } from './kanban-board/constants';
import { QuestionsPanel } from './new-task-dialog/questions-panel';

// ============================================================================
// RESIZE & DRAG HOOKS
// ============================================================================

interface DialogSize {
  width: number;
  height: number;
}

interface DialogPosition {
  x: number;
  y: number;
}

const MIN_WIDTH = 800;
const MIN_HEIGHT = 500;

/**
 * Calculate default dialog dimensions based on current viewport size.
 * Called at runtime to ensure accurate values after window resizes.
 */
function getDialogDefaults(): DialogSize {
  return {
    width: Math.min(1200, window.innerWidth * 0.95),
    height: Math.min(800, window.innerHeight * 0.85),
  };
}

function useResizableDialog() {
  const [size, setSize] = useState<DialogSize>(getDialogDefaults);
  const [isResizing, setIsResizing] = useState(false);
  const startPos = useRef({ x: 0, y: 0 });
  const startSize = useRef({ width: 0, height: 0 });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startPos.current = { x: e.clientX, y: e.clientY };
      startSize.current = { ...size };
    },
    [size]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startPos.current.x;
      const deltaY = e.clientY - startPos.current.y;

      setSize({
        width: Math.max(
          MIN_WIDTH,
          Math.min(window.innerWidth - 40, startSize.current.width + deltaX * 2)
        ),
        height: Math.max(
          MIN_HEIGHT,
          Math.min(window.innerHeight - 40, startSize.current.height + deltaY * 2)
        ),
      });
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const reset = useCallback(() => {
    setSize(getDialogDefaults());
  }, []);

  return { size, isResizing, handleMouseDown, reset };
}

/**
 * Hook for making the dialog draggable
 */
function useDraggableDialog() {
  const [position, setPosition] = useState<DialogPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const startPos = useRef({ x: 0, y: 0 });
  const startOffset = useRef({ x: 0, y: 0 });

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      // Don't start drag if clicking on buttons or inputs
      const target = e.target as HTMLElement;
      if (
        target.closest('button') ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('[role="slider"]')
      ) {
        return;
      }

      e.preventDefault();
      setIsDragging(true);
      startPos.current = { x: e.clientX, y: e.clientY };
      startOffset.current = position ?? { x: 0, y: 0 };
    },
    [position]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startPos.current.x;
      const deltaY = e.clientY - startPos.current.y;

      setPosition({
        x: startOffset.current.x + deltaX,
        y: startOffset.current.y + deltaY,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const resetPosition = useCallback(() => {
    setPosition(null);
  }, []);

  return { position, isDragging, handleDragStart, resetPosition };
}

// ============================================================================
// TYPES
// ============================================================================

interface NewTaskDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTaskCreated?: (taskId: string) => void;
}

// SuggestedTask type for local editing state (extends TaskSuggestion with Priority type)
interface EditableSuggestion {
  title: string;
  description: string;
  labels: string[];
  priority: Priority;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const AVAILABLE_LABELS = ['feature', 'bug', 'enhancement', 'docs', 'refactor', 'test', 'research'];

// Terraform workflow quick suggestions organized by persona
const TERRAFORM_WORKFLOWS = {
  consumer: [
    { label: 'Deploy VPC', description: 'Deploy a VPC using registry modules' },
    { label: 'Add RDS database', description: 'Provision an RDS instance with security groups' },
    { label: 'Setup EKS cluster', description: 'Create a Kubernetes cluster on AWS' },
  ],
  platform: [
    { label: 'Create module', description: 'Build a reusable Terraform module' },
    { label: 'Add module tests', description: 'Write Terraform tests for a module' },
    { label: 'Publish to registry', description: 'Publish module to private registry' },
  ],
  uplift: [
    { label: 'Upgrade providers', description: 'Uplift provider versions to latest stable' },
    {
      label: 'Modernize config',
      description: 'Refactor legacy Terraform to current best practices',
    },
    {
      label: 'Add moved blocks',
      description: 'Migrate resources using moved blocks for state refactoring',
    },
  ],
};

const DEFAULT_SUGGESTION: EditableSuggestion = {
  title: '',
  description: '',
  labels: [],
  priority: 'medium',
};

/**
 * Strip machine-readable JSON blocks from message content.
 * This includes task_suggestion and clarifying_questions blocks that shouldn't be shown to users.
 *
 * Uses progressive JSON.parse to find the correct closing ``` fence, which handles
 * descriptions that contain nested triple-backtick markdown (e.g. directory trees).
 */
function stripMachineReadableJson(content: string): string {
  const openMarker = '```json';
  const closeMarker = '```';
  let result = content;
  let searchFrom = 0;

  // Process all ```json blocks
  let safetyLimit = 20;
  while (safetyLimit-- > 0) {
    const openIdx = result.indexOf(openMarker, searchFrom);
    if (openIdx === -1) break;

    const contentStart = openIdx + openMarker.length;
    let removed = false;

    // Try each subsequent ``` as a potential closing fence
    let closeSearch = contentStart;
    while (true) {
      const closeIdx = result.indexOf(closeMarker, closeSearch);
      if (closeIdx === -1) break;

      const candidate = result.substring(contentStart, closeIdx).trim();
      if (candidate.length > 0) {
        try {
          const parsed = JSON.parse(candidate);
          // Only strip blocks that are machine-readable task/question JSON
          if (
            parsed &&
            typeof parsed === 'object' &&
            (parsed.type === 'task_suggestion' || parsed.type === 'clarifying_questions')
          ) {
            // Remove the entire fenced block (including closing ```)
            result = result.substring(0, openIdx) + result.substring(closeIdx + closeMarker.length);
            removed = true;
            break;
          }
          // Valid JSON but not a machine-readable block — stop trying further fences for this opening
          break;
        } catch {
          // Not valid JSON yet — try the next ``` further along
        }
      }
      closeSearch = closeIdx + closeMarker.length;
    }

    if (!removed) {
      // Skip past this ```json opening and continue searching for more
      searchFrom = contentStart;
    }
    // If removed, searchFrom stays the same (or resets to 0) to catch adjacent blocks
  }

  return result.trim();
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

/** Thinking phrases that cycle while waiting for Claude */
const THINKING_PHRASES = [
  'Analyzing requirements',
  'Structuring task',
  'Considering approach',
  'Drafting details',
  'Evaluating scope',
  'Mapping dependencies',
  'Refining description',
  'Checking best practices',
  'Formulating response',
  'Almost there',
];

/**
 * Claude-style thinking indicator with cycling breadcrumb words
 */
function ThinkingIndicator(): React.JSX.Element {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsTransitioning(true);
      setTimeout(() => {
        setPhraseIndex((prev) => (prev + 1) % THINKING_PHRASES.length);
        setIsTransitioning(false);
      }, 150);
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {/* Animated dots */}
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-claude"
            style={{
              animation: 'pulse-dot 1.4s infinite ease-in-out both',
              animationDelay: `${i * 0.16}s`,
            }}
          />
        ))}
      </div>
      {/* Cycling phrase */}
      <span
        className={cn(
          'text-sm text-fg-muted transition-all duration-150',
          isTransitioning ? 'opacity-0 translate-y-1' : 'opacity-100 translate-y-0'
        )}
      >
        {THINKING_PHRASES[phraseIndex]}
      </span>
      {/* Ellipsis animation */}
      <span className="text-sm text-fg-muted">
        <span className="inline-block animate-pulse">...</span>
      </span>
      <style>{`
        @keyframes pulse-dot {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

/**
 * Chat message bubble - Claude branded for AI messages
 */
function MessageBubble({ message }: { message: TaskCreationMessage }): React.JSX.Element {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          isUser
            ? 'bg-accent-muted text-accent border border-accent/20'
            : 'bg-claude-muted text-claude border border-claude/20'
        )}
      >
        {isUser ? (
          <User className="h-4 w-4" weight="bold" />
        ) : (
          <svg viewBox="0 0 248 248" fill="currentColor" className="h-4 w-4" aria-hidden="true">
            <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
          </svg>
        )}
      </div>

      {/* Message */}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-2.5',
          isUser
            ? 'rounded-tr-md bg-accent text-white'
            : 'rounded-tl-md bg-surface-muted border border-border'
        )}
      >
        <p className="text-sm whitespace-pre-wrap leading-relaxed">
          {isUser ? message.content : stripMachineReadableJson(message.content)}
        </p>
      </div>
    </div>
  );
}

/**
 * Streaming message bubble (shows content as it streams) - Claude branded
 */
function StreamingBubble({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-claude-muted text-claude border border-claude/20">
        <svg viewBox="0 0 248 248" fill="currentColor" className="h-4 w-4" aria-hidden="true">
          <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
        </svg>
      </div>
      <div className="max-w-[80%] rounded-2xl rounded-tl-md bg-surface-muted border border-border px-4 py-2.5">
        <p className="text-sm whitespace-pre-wrap leading-relaxed">
          {stripMachineReadableJson(content)}
          <span className="inline-block w-2 h-4 ml-0.5 bg-claude/60 animate-pulse" />
        </p>
      </div>
    </div>
  );
}

/**
 * Task preview card showing the generated task details - Claude branded
 */
function SuggestionCard({
  suggestion,
  onAccept,
  onEdit,
}: {
  suggestion: TaskSuggestion;
  onAccept: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  return (
    <div className="mx-4 mt-4 rounded-xl border-2 border-claude/40 bg-gradient-to-br from-claude/5 to-claude/10 overflow-hidden shadow-lg flex flex-col">
      {/* Header with title */}
      <div className="px-4 py-2.5 bg-claude/10 border-b border-claude/20">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <svg
                viewBox="0 0 248 248"
                fill="currentColor"
                className="h-3.5 w-3.5 text-claude shrink-0"
                aria-hidden="true"
              >
                <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
              </svg>
              <span className="text-[10px] font-semibold text-claude uppercase tracking-wide">
                Task Preview
              </span>
            </div>
            <h3 className="text-base font-semibold text-fg leading-tight">{suggestion.title}</h3>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={cn(
                'px-2 py-0.5 rounded text-[10px] font-medium',
                suggestion.priority === 'high' && 'bg-danger-muted text-danger-fg',
                suggestion.priority === 'medium' && 'bg-attention-muted text-attention-fg',
                suggestion.priority === 'low' && 'bg-success-muted text-success-fg'
              )}
            >
              {suggestion.priority}
            </span>
            {suggestion.labels.map((label) => {
              const colors = getLabelColors(label);
              return (
                <span
                  key={label}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] font-medium',
                    colors.bg,
                    colors.text
                  )}
                >
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* Description - takes remaining space */}
      <div className="flex-1 overflow-y-auto p-3 min-h-0">
        <p className="text-sm text-fg-muted whitespace-pre-wrap leading-relaxed">
          {suggestion.description}
        </p>
      </div>

      {/* Actions - compact footer */}
      <div className="px-3 py-2 bg-surface/30 border-t border-claude/20 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="px-3 py-1.5 text-xs font-medium text-fg-muted hover:text-fg border border-border rounded-md hover:bg-surface-muted transition-colors"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onAccept}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-claude hover:bg-claude/90 rounded-md transition-colors shadow-sm"
        >
          <Check className="h-4 w-4" weight="bold" />
          Create Task
        </button>
      </div>
    </div>
  );
}

/**
 * Task details sidebar - always visible, shows priority and tags
 */
function TaskDetailsSidebar({
  priority,
  tags,
  onPriorityChange,
  onTagsChange,
  onCreateManually,
}: {
  priority: Priority;
  tags: string[];
  onPriorityChange: (p: Priority) => void;
  onTagsChange: (tags: string[]) => void;
  onCreateManually: () => void;
}): React.JSX.Element {
  return (
    <div className="w-72 border-l border-border bg-surface-subtle/30 flex flex-col">
      <div className="p-4 border-b border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-1">
          Task Details
        </h3>
        <p className="text-[10px] text-fg-muted">Configure before or after chat</p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Priority */}
        <div className="space-y-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            Priority
          </span>
          <div className="flex gap-1.5">
            {(['high', 'medium', 'low'] as Priority[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onPriorityChange(p)}
                className={cn(
                  'flex-1 px-2 py-2 rounded-lg text-xs font-medium transition-all border text-center',
                  priority === p
                    ? cn(
                        p === 'high' && 'bg-danger-muted text-danger-fg border-danger-fg/30',
                        p === 'medium' &&
                          'bg-attention-muted text-attention-fg border-attention-fg/30',
                        p === 'low' && 'bg-success-muted text-success-fg border-success-fg/30'
                      )
                    : 'bg-surface text-fg-muted border-border hover:text-fg hover:bg-surface-muted'
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            Tags
          </span>
          <div className="flex flex-wrap gap-1.5">
            {AVAILABLE_LABELS.map((label) => {
              const colors = getLabelColors(label);
              const isSelected = tags.includes(label);
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    onTagsChange(isSelected ? tags.filter((t) => t !== label) : [...tags, label]);
                  }}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-[11px] font-medium transition-all',
                    colors.bg,
                    colors.text,
                    isSelected ? 'ring-1 ring-current' : 'opacity-60 hover:opacity-100'
                  )}
                >
                  {label}
                  {isSelected && <Check className="inline ml-1 h-2.5 w-2.5" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Manual create option */}
      <div className="p-4 border-t border-border">
        <button
          type="button"
          onClick={onCreateManually}
          className="w-full px-3 py-2.5 rounded-lg text-xs font-medium text-fg-muted hover:text-fg border border-border hover:bg-surface-muted transition-colors"
        >
          <Plus className="inline h-3 w-3 mr-1.5" />
          Create task manually
        </button>
      </div>
    </div>
  );
}

/**
 * Terraform workflow suggestions - organized by persona
 */
function TerraformWorkflows({
  onSelect,
  onCreateManually,
}: {
  onSelect: (text: string) => void;
  onCreateManually: () => void;
}): React.JSX.Element {
  const personas = [
    { key: 'consumer', label: 'App Consumer', icon: '🚀', color: 'text-accent' },
    { key: 'platform', label: 'Platform Team', icon: '🔧', color: 'text-claude' },
    { key: 'uplift', label: 'Uplift & Migrate', icon: '⬆️', color: 'text-done-fg' },
  ] as const;

  return (
    <div className="flex flex-col gap-4 px-4 py-4 border-t border-border bg-surface-subtle/30">
      <div className="text-center">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
          Terraform Workflows
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {personas.map((persona) => (
          <div key={persona.key} className="flex flex-col gap-2">
            <div className={cn('text-xs font-medium flex items-center gap-1.5', persona.color)}>
              <span>{persona.icon}</span>
              {persona.label}
            </div>
            <div className="flex flex-col gap-1.5">
              {TERRAFORM_WORKFLOWS[persona.key].map((workflow) => (
                <button
                  key={workflow.label}
                  type="button"
                  onClick={() => onSelect(workflow.description)}
                  className={cn(
                    'text-left px-2.5 py-2 rounded-lg text-xs',
                    'bg-surface border border-border',
                    'hover:bg-claude/5 hover:border-claude/30',
                    'transition-colors duration-150 group'
                  )}
                >
                  <div className="font-medium text-fg group-hover:text-claude transition-colors">
                    {workflow.label}
                  </div>
                  <div className="text-[10px] text-fg-muted mt-0.5 line-clamp-1">
                    {workflow.description}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-center pt-1">
        <button
          type="button"
          onClick={onCreateManually}
          className={cn(
            'px-3 py-1.5 rounded-lg text-xs font-medium',
            'text-fg-muted hover:text-fg',
            'transition-colors duration-150'
          )}
        >
          or <span className="underline">create manually</span> without AI
        </button>
      </div>
    </div>
  );
}
/**
 * Edit panel for refining the task - Claude branded with two-column layout
 */
function EditPanel({
  suggestion,
  onChange,
  onSubmit,
  onBack,
  isSubmitting,
  onDragStart,
}: {
  suggestion: EditableSuggestion;
  onChange: (updates: Partial<EditableSuggestion>) => void;
  onSubmit: () => void;
  onBack: () => void;
  isSubmitting: boolean;
  onDragStart?: (e: React.MouseEvent) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col h-full bg-gradient-to-br from-surface via-surface to-claude/[0.02]">
      {/* Header - Claude branded, Draggable */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle for dialog positioning */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b border-claude/20 bg-claude/5 cursor-move"
        onMouseDown={onDragStart}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-claude hover:text-claude hover:bg-claude/10 transition-colors"
          >
            <ArrowRight className="h-4 w-4 rotate-180" />
          </button>
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
              <h3 className="text-sm font-semibold text-fg">Refine Task</h3>
              <p className="text-[10px] text-fg-muted">Review and edit before creating</p>
            </div>
          </div>
        </div>
        {/* Quick metadata badges */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-medium',
              suggestion.priority === 'high' && 'bg-danger-muted text-danger-fg',
              suggestion.priority === 'medium' && 'bg-attention-muted text-attention-fg',
              suggestion.priority === 'low' && 'bg-success-muted text-success-fg'
            )}
          >
            {suggestion.priority}
          </span>
          {suggestion.labels.slice(0, 2).map((label) => {
            const colors = getLabelColors(label);
            return (
              <span
                key={label}
                className={cn(
                  'px-2 py-0.5 rounded text-[10px] font-medium',
                  colors.bg,
                  colors.text
                )}
              >
                {label}
              </span>
            );
          })}
          {suggestion.labels.length > 2 && (
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-surface-muted text-fg-muted">
              +{suggestion.labels.length - 2}
            </span>
          )}
        </div>
      </div>

      {/* Two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Task content (larger) */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border">
          {/* Title input - prominent */}
          <div className="px-4 py-3 border-b border-border bg-surface/50">
            <input
              id="task-title-input"
              type="text"
              value={suggestion.title}
              onChange={(e) => onChange({ title: e.target.value })}
              placeholder="Task title..."
              className={cn(
                'w-full text-lg font-semibold bg-transparent border-none p-0 text-fg',
                'placeholder:text-fg-subtle/50',
                'focus:outline-none focus:ring-0'
              )}
            />
          </div>

          {/* Task details - fills remaining space */}
          <div className="flex-1 flex flex-col min-h-0 p-4">
            <label
              htmlFor="task-details-input"
              className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2 block shrink-0"
            >
              Task Details
            </label>
            <textarea
              id="task-details-input"
              value={suggestion.description}
              onChange={(e) => onChange({ description: e.target.value })}
              placeholder="Describe what needs to be done..."
              className={cn(
                'w-full flex-1 min-h-[200px] p-3 rounded-lg resize-none',
                'bg-surface border border-border text-sm text-fg leading-relaxed',
                'placeholder:text-fg-subtle/50',
                'focus:outline-none focus:border-claude focus:ring-1 focus:ring-claude/30',
                'transition-colors'
              )}
            />
          </div>
        </div>

        {/* Right: Metadata sidebar */}
        <div className="w-64 flex flex-col bg-surface-subtle/30">
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* Priority */}
            <div className="space-y-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
                Priority
              </span>
              <div className="flex gap-1.5">
                {(['high', 'medium', 'low'] as Priority[]).map((priority) => (
                  <button
                    key={priority}
                    type="button"
                    onClick={() => onChange({ priority })}
                    className={cn(
                      'flex-1 px-2 py-2 rounded-lg text-xs font-medium transition-all border text-center',
                      suggestion.priority === priority
                        ? cn(
                            priority === 'high' &&
                              'bg-danger-muted text-danger-fg border-danger-fg/30',
                            priority === 'medium' &&
                              'bg-attention-muted text-attention-fg border-attention-fg/30',
                            priority === 'low' &&
                              'bg-success-muted text-success-fg border-success-fg/30'
                          )
                        : 'bg-surface text-fg-muted border-border hover:text-fg hover:bg-surface-muted'
                    )}
                  >
                    {priority}
                  </button>
                ))}
              </div>
            </div>

            {/* Tags */}
            <div className="space-y-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
                Tags
              </span>
              <div className="flex flex-wrap gap-1.5">
                {AVAILABLE_LABELS.map((label) => {
                  const colors = getLabelColors(label);
                  const isSelected = suggestion.labels.includes(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        onChange({
                          labels: isSelected
                            ? suggestion.labels.filter((l) => l !== label)
                            : [...suggestion.labels, label],
                        });
                      }}
                      className={cn(
                        'px-2.5 py-1 rounded-full text-[11px] font-medium transition-all',
                        colors.bg,
                        colors.text,
                        isSelected ? 'ring-1 ring-current' : 'opacity-50 hover:opacity-100'
                      )}
                    >
                      {label}
                      {isSelected && <Check className="inline ml-1 h-2.5 w-2.5" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Actions in sidebar footer */}
          <div className="p-4 border-t border-border space-y-2">
            <button
              type="button"
              onClick={onSubmit}
              disabled={!suggestion.title.trim() || isSubmitting}
              className={cn(
                'w-full h-10 rounded-lg inline-flex items-center justify-center gap-2 text-sm font-medium transition-all',
                suggestion.title.trim() && !isSubmitting
                  ? 'bg-claude text-white hover:bg-claude/90 shadow-sm'
                  : 'bg-surface-muted text-fg-subtle cursor-not-allowed'
              )}
            >
              {isSubmitting ? (
                <>
                  <Spinner className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" weight="bold" />
                  Create Task
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onBack}
              className="w-full h-9 rounded-lg text-xs font-medium text-fg-muted border border-border hover:bg-surface-muted transition-colors"
            >
              Back to Chat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function NewTaskDialog({
  projectId,
  open,
  onOpenChange,
  onTaskCreated,
}: NewTaskDialogProps): React.JSX.Element {
  // Use the real AI task creation hook
  const {
    sessionId,
    status,
    messages,
    streamingContent,
    isStreaming,
    isAnswering,
    suggestion,
    pendingQuestions,
    createdTaskId,
    error,
    startConversation,
    sendMessage,
    acceptSuggestion,
    answerQuestions,
    skipQuestions,
    cancel,
    reset,
  } = useTaskCreation(projectId);

  // Resizable and draggable dialog
  const { size, isResizing, handleMouseDown } = useResizableDialog();
  const { position, isDragging, handleDragStart, resetPosition } = useDraggableDialog();

  const [input, setInput] = useState('');
  const [editableSuggestion, setEditableSuggestion] = useState<EditableSuggestion | null>(null);
  const [showEditPanel, setShowEditPanel] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isManualMode, setIsManualMode] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedPriority, setSelectedPriority] = useState<Priority>('medium');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string | string[]>>({});

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Convert TaskSuggestion to EditableSuggestion when suggestion changes
  useEffect(() => {
    if (suggestion) {
      setEditableSuggestion({
        title: suggestion.title,
        description: suggestion.description,
        labels: suggestion.labels,
        priority: suggestion.priority as Priority,
      });
    }
  }, [suggestion]);

  // Reset selected answers when new questions arrive
  // Track which question ID the selected answers belong to (prevents race conditions)
  const pendingQuestionsId = pendingQuestions?.id;
  const prevQuestionsIdRef = useRef<string | undefined>(undefined);
  const answersQuestionsIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    console.log('[NewTaskDialog] Questions effect:', {
      pendingQuestionsId,
      prevId: prevQuestionsIdRef.current,
      answersForId: answersQuestionsIdRef.current,
      isNew: pendingQuestionsId !== prevQuestionsIdRef.current,
      round: pendingQuestions?.round,
      headers: pendingQuestions?.questions.map((q) => q.header),
    });
    // Check if this is a NEW set of questions (different ID)
    if (pendingQuestionsId && pendingQuestionsId !== prevQuestionsIdRef.current) {
      console.log('[NewTaskDialog] New questions detected! Resetting answers.');
      // Always reset answers for new questions (they have different indices)
      setSelectedAnswers({});
      // IMPORTANT: Clear the ref to indicate no answers selected for this round yet
      // This prevents stale answers from being submitted before user makes selections
      answersQuestionsIdRef.current = undefined;
    }
    prevQuestionsIdRef.current = pendingQuestionsId;
  }, [pendingQuestionsId, pendingQuestions]);

  // Start conversation when dialog opens
  useEffect(() => {
    if (open && status === 'idle') {
      startConversation();
    }
  }, [open, status, startConversation]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      reset();
      resetPosition();
      setInput('');
      setEditableSuggestion(null);
      setShowEditPanel(false);
      setIsSubmitting(false);
      setIsManualMode(false);
      setLocalError(null);
      setSelectedPriority('medium');
      setSelectedTags([]);
      setSelectedAnswers({});
    } else {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, reset, resetPosition]);

  // Handle task creation completion
  useEffect(() => {
    if (createdTaskId) {
      onTaskCreated?.(createdTaskId);
      onOpenChange(false);
    }
  }, [createdTaskId, onTaskCreated, onOpenChange]);

  // Auto-scroll to bottom when messages change or streaming
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger deps for scroll behavior
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    const message = input.trim();
    setInput('');
    await sendMessage(message);
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAcceptSuggestion = async () => {
    if (!editableSuggestion) {
      console.error('[NewTaskDialog] No editable suggestion available');
      return;
    }

    console.log('[NewTaskDialog] Accepting suggestion:', editableSuggestion);
    setIsSubmitting(true);
    setLocalError(null);
    try {
      // Directly create task using the AI suggestion
      const result = await acceptSuggestion({
        title: editableSuggestion.title,
        description: editableSuggestion.description,
        labels: editableSuggestion.labels,
        priority: editableSuggestion.priority,
      });

      if (!result.ok) {
        console.error('[NewTaskDialog] Accept failed:', result.error);
        setLocalError(result.error ?? 'Failed to create task');
        setIsSubmitting(false);
        return;
      }

      console.log('[NewTaskDialog] acceptSuggestion call completed successfully');
      // Note: Dialog will close automatically when createdTaskId is set via SSE event
    } catch (err) {
      console.error('[NewTaskDialog] Error accepting suggestion:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to create task');
      setIsSubmitting(false);
    }
  };

  const handleCreateManually = () => {
    // Cancel any active AI session
    if (sessionId && status === 'active') {
      cancel();
    }
    // Set up empty suggestion with user-selected options and go to edit panel
    setEditableSuggestion({
      ...DEFAULT_SUGGESTION,
      priority: selectedPriority,
      labels: selectedTags,
    });
    setShowEditPanel(true);
    setIsManualMode(true);
  };

  const handleSubmit = async () => {
    if (!editableSuggestion || isSubmitting) return;

    setIsSubmitting(true);
    setLocalError(null);
    try {
      if (isManualMode) {
        // Manual mode: Create task directly without AI session
        const result = await apiClient.tasks.create({
          projectId,
          title: editableSuggestion.title,
          description: editableSuggestion.description,
          labels: editableSuggestion.labels,
          priority: editableSuggestion.priority,
        });

        if (result.ok) {
          onTaskCreated?.(result.data.taskId);
          onOpenChange(false);
        } else {
          setLocalError(result.error.message);
        }
      } else {
        // AI mode: Use the acceptSuggestion from the hook
        const result = await acceptSuggestion({
          title: editableSuggestion.title,
          description: editableSuggestion.description,
          labels: editableSuggestion.labels,
          priority: editableSuggestion.priority,
        });

        if (!result.ok) {
          setLocalError(result.error ?? 'Failed to create task');
        }
        // Success: Dialog will close automatically when createdTaskId is set via SSE event
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle submitting answers to questions
  // isStreaming state from durable streams automatically tracks processing
  // Includes validation to prevent submitting stale answers from previous rounds
  const handleSubmitAnswers = useCallback(async () => {
    if (!pendingQuestions) return;

    // CRITICAL: Check that answers belong to the current question round
    // This prevents race conditions where old answers are submitted for new questions
    // Also blocks if no answers have been selected yet (ref is undefined)
    if (answersQuestionsIdRef.current !== pendingQuestions.id) {
      console.warn(
        '[NewTaskDialog] Answers are for a different question round or none selected - not submitting',
        { answersForId: answersQuestionsIdRef.current, currentId: pendingQuestions.id }
      );
      // Clear stale answers - leave ref undefined until user selects new answers
      setSelectedAnswers({});
      answersQuestionsIdRef.current = undefined;
      return;
    }

    // Validate that all answers match valid options for the current questions
    // This guards against edge cases where answers might not match
    const isValid = pendingQuestions.questions.every((question, index) => {
      const answer = selectedAnswers[String(index)];
      if (answer === undefined) return false;

      const validLabels = question.options.map((o) => o.label);

      if (question.multiSelect) {
        if (!Array.isArray(answer) || answer.length === 0) return false;
        return answer.every((a) => validLabels.includes(a));
      }
      return typeof answer === 'string' && validLabels.includes(answer);
    });

    if (!isValid) {
      console.warn('[NewTaskDialog] Detected invalid answers - not submitting');
      // Clear stale answers if validation fails
      setSelectedAnswers({});
      return;
    }

    try {
      await answerQuestions(selectedAnswers);
    } catch (error) {
      console.error('[NewTaskDialog] Error submitting answers:', error);
    }
  }, [pendingQuestions, answerQuestions, selectedAnswers]);

  // Handle skipping questions
  const handleSkipQuestions = useCallback(async () => {
    try {
      await skipQuestions();
    } catch (error) {
      console.error('[NewTaskDialog] Error skipping questions:', error);
    }
  }, [skipQuestions]);

  // Handle selecting an answer for a question (supports both single and multi-select)
  // Also tracks which question ID these answers belong to
  const handleSelectAnswer = useCallback(
    (questionIndex: number, answer: string | string[]) => {
      // Update the ref to track which questions these answers are for
      // This is critical for preventing stale answer submission
      if (pendingQuestionsId) {
        answersQuestionsIdRef.current = pendingQuestionsId;
      }
      setSelectedAnswers((prev) => ({
        ...prev,
        [String(questionIndex)]: answer,
      }));
    },
    [pendingQuestionsId]
  );

  const handleClose = () => {
    console.log('[NewTaskDialog] handleClose called', { sessionId, status });
    if (sessionId && (status === 'active' || status === 'waiting_user')) {
      console.log('[NewTaskDialog] Calling cancel for session:', sessionId);
      void cancel();
    }
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleClose}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        />

        <DialogPrimitive.Content
          className={cn(
            'fixed z-50',
            'bg-surface border border-border rounded-xl overflow-hidden',
            'shadow-xl flex flex-col',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'duration-200',
            (isResizing || isDragging) && 'select-none'
          )}
          style={{
            width: `${size.width}px`,
            height: `${size.height}px`,
            // Use position offset or center the dialog
            left: position ? `calc(50% + ${position.x}px)` : '50%',
            top: position ? `calc(50% + ${position.y}px)` : '50%',
            transform: 'translate(-50%, -50%)',
          }}
          data-testid="new-task-dialog"
        >
          {showEditPanel && editableSuggestion ? (
            <EditPanel
              suggestion={editableSuggestion}
              onChange={(updates) =>
                setEditableSuggestion((prev) => (prev ? { ...prev, ...updates } : null))
              }
              onSubmit={handleSubmit}
              onBack={() => setShowEditPanel(false)}
              isSubmitting={isSubmitting}
              onDragStart={handleDragStart}
            />
          ) : (
            <div className="flex flex-1 overflow-hidden">
              {/* LEFT PANEL - Main content */}
              <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
                {/* Compact Header - Draggable */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle for dialog positioning */}
                <div
                  className="flex items-center justify-between px-4 py-3 border-b border-border cursor-move"
                  onMouseDown={handleDragStart}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-lg',
                        status === 'connecting'
                          ? 'bg-attention-muted text-attention'
                          : status === 'error'
                            ? 'bg-danger-muted text-danger'
                            : 'bg-claude-muted text-claude'
                      )}
                    >
                      {status === 'connecting' ? (
                        <Spinner className="h-4 w-4 animate-spin" />
                      ) : status === 'error' ? (
                        <Warning className="h-4 w-4" weight="fill" />
                      ) : (
                        <svg
                          viewBox="0 0 248 248"
                          fill="currentColor"
                          className="h-4 w-4"
                          aria-hidden="true"
                        >
                          <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
                        </svg>
                      )}
                    </div>
                    <div>
                      <DialogPrimitive.Title className="text-sm font-semibold text-fg flex items-center gap-2">
                        Create with Claude
                        {status === 'active' && (
                          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-success-fg animate-pulse" />
                        )}
                      </DialogPrimitive.Title>
                      <DialogPrimitive.Description className="text-[11px] text-fg-muted">
                        {status === 'connecting'
                          ? 'Connecting...'
                          : status === 'error'
                            ? 'Connection error'
                            : 'Describe your Terraform task'}
                      </DialogPrimitive.Description>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Input - FIRST, prominent */}
                <div className="p-4 border-b border-border bg-surface-subtle/30">
                  <div className="relative">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="What do you want to build with Terraform?"
                      rows={2}
                      disabled={status !== 'active'}
                      className={cn(
                        'w-full px-4 py-3 pr-12 rounded-lg resize-none',
                        'bg-surface border-2 text-sm text-fg',
                        'placeholder:text-fg-subtle',
                        'focus:outline-none',
                        'transition-all duration-300',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        // Glow effect when text is entered
                        input.trim()
                          ? 'border-claude shadow-[0_0_15px_rgba(217,119,87,0.3)] ring-2 ring-claude/20'
                          : 'border-border focus:border-claude focus:ring-1 focus:ring-claude/30'
                      )}
                    />
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!input.trim() || isStreaming || status !== 'active'}
                      className={cn(
                        'absolute right-2 bottom-3 h-8 w-8 rounded-md',
                        'flex items-center justify-center transition-all duration-300',
                        input.trim() && !isStreaming && status === 'active'
                          ? 'bg-claude text-white hover:bg-claude/90 shadow-[0_0_12px_rgba(217,119,87,0.5)] animate-pulse'
                          : 'bg-surface-muted text-fg-subtle cursor-not-allowed'
                      )}
                    >
                      <PaperPlaneTilt className="h-4 w-4" weight="fill" />
                    </button>
                  </div>
                  {/* Enter hint - more prominent when text is entered */}
                  <p
                    className={cn(
                      'mt-1.5 px-1 transition-all duration-300',
                      input.trim()
                        ? 'text-[11px] text-claude font-medium'
                        : 'text-[10px] text-fg-subtle'
                    )}
                  >
                    Press{' '}
                    <kbd
                      className={cn(
                        'px-1.5 py-0.5 rounded font-mono text-[9px] transition-all duration-300',
                        input.trim()
                          ? 'bg-claude/10 border border-claude/30 text-claude shadow-[0_0_8px_rgba(217,119,87,0.2)]'
                          : 'bg-surface-muted border border-border'
                      )}
                    >
                      Enter
                    </kbd>{' '}
                    to send
                  </p>
                </div>

                {/* Error banner */}
                {(error || localError) && (
                  <div className="px-4 py-2 bg-danger/10 border-b border-danger/20 flex items-center gap-2">
                    <Warning className="h-3.5 w-3.5 text-danger" weight="fill" />
                    <p className="text-xs text-danger">{error || localError}</p>
                  </div>
                )}

                {/* Clarifying questions panel - show when waiting for user answers */}
                {status === 'waiting_user' && pendingQuestions && (
                  <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    <QuestionsPanel
                      pendingQuestions={pendingQuestions}
                      selectedAnswers={selectedAnswers}
                      onSelectAnswer={handleSelectAnswer}
                      onSubmitAnswers={handleSubmitAnswers}
                      onSkip={handleSkipQuestions}
                      isSubmitting={isStreaming || isAnswering}
                    />
                  </div>
                )}

                {/* Terraform workflows - show when no conversation yet */}
                {messages.length === 0 &&
                  !pendingQuestions &&
                  !isStreaming &&
                  (status === 'active' || status === 'error' || status === 'connecting') && (
                    <div className="flex-1 overflow-y-auto">
                      <TerraformWorkflows
                        onSelect={(text) => setInput(text)}
                        onCreateManually={handleCreateManually}
                      />
                    </div>
                  )}

                {/* Processing state - show when streaming without messages yet */}
                {messages.length === 0 && isStreaming && (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-claude-muted text-claude border border-claude/20">
                        <Spinner className="h-6 w-6 animate-spin" />
                      </div>
                      <p className="text-sm text-fg-muted">Processing your request...</p>
                    </div>
                  </div>
                )}

                {/* Chat messages - show when conversation started (regardless of status, as long as not waiting_user) */}
                {messages.length > 0 && !(status === 'waiting_user' && pendingQuestions) && (
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {messages.map((message) => (
                      <div key={message.id}>
                        <MessageBubble message={message} />
                        {message.role === 'assistant' &&
                          suggestion &&
                          message.id === messages[messages.length - 1]?.id && (
                            <SuggestionCard
                              suggestion={suggestion}
                              onAccept={handleAcceptSuggestion}
                              onEdit={() => setShowEditPanel(true)}
                            />
                          )}
                      </div>
                    ))}
                    {/* Streaming content */}
                    {isStreaming && streamingContent && (
                      <StreamingBubble content={streamingContent} />
                    )}
                    {/* Typing indicator */}
                    {isStreaming && !streamingContent && (
                      <div className="flex gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-claude-muted text-claude border border-claude/20">
                          <svg
                            viewBox="0 0 248 248"
                            fill="currentColor"
                            className="h-4 w-4 animate-pulse"
                            aria-hidden="true"
                          >
                            <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
                          </svg>
                        </div>
                        <div className="rounded-2xl rounded-tl-md bg-surface-muted border border-border">
                          <ThinkingIndicator />
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* RIGHT PANEL - Task Details Sidebar */}
              <TaskDetailsSidebar
                priority={selectedPriority}
                tags={selectedTags}
                onPriorityChange={setSelectedPriority}
                onTagsChange={setSelectedTags}
                onCreateManually={handleCreateManually}
              />
            </div>
          )}

          {/* Resize handle */}
          <div
            role="slider"
            aria-label="Resize dialog"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={window.innerWidth - 40}
            aria-valuenow={size.width}
            tabIndex={0}
            onMouseDown={handleMouseDown}
            className={cn(
              'absolute bottom-0 right-0 w-6 h-6 cursor-se-resize',
              'flex items-center justify-center',
              'text-fg-subtle hover:text-fg transition-colors',
              'rounded-tl-md hover:bg-surface-muted'
            )}
            title="Drag to resize"
          >
            <ArrowsOutCardinal className="w-3.5 h-3.5 rotate-45" />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
