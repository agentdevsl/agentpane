import { Sparkle, User } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import type { PlanStreamPanelProps, StreamMessage } from './types';

/**
 * Format relative time from timestamp
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Streaming cursor animation - blinking caret
 */
function StreamCursor(): React.JSX.Element {
  return (
    <span className="inline-flex ml-0.5">
      <span
        className={cn(
          'inline-block w-[2px] h-[1.1em] bg-secondary',
          'animate-[blink_1s_step-end_infinite]'
        )}
        style={{
          animation: 'blink 1s step-end infinite',
        }}
      />
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </span>
  );
}

/**
 * Typing indicator dots
 */
function TypingIndicator(): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 px-2 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-secondary/60"
          style={{
            animation: `bounce 1.4s infinite ease-in-out both`,
            animationDelay: `${i * 0.16}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

/**
 * Claude's avatar with glow effect
 */
function ClaudeAvatar({ isActive }: { isActive?: boolean }): React.JSX.Element {
  return (
    <div className="relative">
      <div
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-xl',
          'bg-gradient-to-br from-secondary/20 to-secondary/5',
          'border border-secondary/30',
          'transition-all duration-300',
          isActive && 'shadow-[0_0_16px_rgba(247,120,186,0.3)]'
        )}
      >
        <Sparkle
          weight="fill"
          className={cn('h-4 w-4 text-secondary', isActive && 'animate-pulse')}
        />
      </div>
      {isActive && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-success border-2 border-canvas" />
      )}
    </div>
  );
}

/**
 * User avatar
 */
function UserAvatar(): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-xl',
        'bg-accent/10 text-accent',
        'border border-accent/20'
      )}
    >
      <User weight="bold" className="h-4 w-4" />
    </div>
  );
}

/**
 * User message bubble - aligned right
 */
function UserMessage({ message }: { message: StreamMessage }): React.JSX.Element {
  return (
    <div className="flex justify-end gap-3 px-4 py-3 animate-fade-in">
      <div className="flex flex-col items-end max-w-[80%]">
        <div
          className={cn(
            'rounded-2xl rounded-tr-md px-4 py-2.5',
            'bg-accent text-white',
            'shadow-sm'
          )}
        >
          <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
            {message.content}
          </p>
        </div>
        <span className="text-[10px] text-fg-subtle mt-1.5 mr-1">
          {formatTime(message.timestamp)}
        </span>
      </div>
      <UserAvatar />
    </div>
  );
}

/**
 * Assistant message bubble - aligned left
 */
function AssistantMessage({
  message,
  isStreaming,
}: {
  message: StreamMessage;
  isStreaming?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex gap-3 px-4 py-3 animate-fade-in">
      <ClaudeAvatar isActive={isStreaming} />
      <div className="flex flex-col max-w-[85%]">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-secondary">Claude</span>
          {isStreaming && (
            <span className="text-[10px] text-fg-subtle flex items-center gap-1">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-secondary" />
              </span>
              thinking
            </span>
          )}
        </div>
        <div
          className={cn(
            'rounded-2xl rounded-tl-md px-4 py-3',
            'bg-surface-muted border border-border/50',
            'shadow-sm'
          )}
        >
          <div className="text-sm text-fg leading-relaxed">
            <p className="whitespace-pre-wrap break-words">
              {message.content}
              {isStreaming && <StreamCursor />}
            </p>
          </div>
        </div>
        {!isStreaming && (
          <span className="text-[10px] text-fg-subtle mt-1.5 ml-1">
            {formatTime(message.timestamp)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Streaming message being typed
 */
function StreamingMessage({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="flex gap-3 px-4 py-3">
      <ClaudeAvatar isActive />
      <div className="flex flex-col max-w-[85%]">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-secondary">Claude</span>
          <span className="text-[10px] text-fg-subtle flex items-center gap-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-secondary" />
            </span>
            thinking
          </span>
        </div>
        <div
          className={cn(
            'rounded-2xl rounded-tl-md px-4 py-3',
            'bg-surface-muted border border-secondary/20',
            'shadow-sm shadow-secondary/5'
          )}
        >
          {content ? (
            <div className="text-sm text-fg leading-relaxed">
              <p className="whitespace-pre-wrap break-words">
                {content}
                <StreamCursor />
              </p>
            </div>
          ) : (
            <TypingIndicator />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Panel for displaying plan conversation messages
 */
export function PlanStreamPanel({
  messages,
  streamingContent,
  isStreaming,
}: PlanStreamPanelProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional triggers to re-scroll when content changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streamingContent]);

  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Messages */}
      <div
        ref={scrollRef}
        className={cn(
          'flex-1 overflow-y-auto py-2',
          'scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent'
        )}
      >
        {hasMessages ? (
          <div className="space-y-1">
            {messages.map((message) =>
              message.role === 'user' ? (
                <UserMessage key={message.id} message={message} />
              ) : (
                <AssistantMessage key={message.id} message={message} />
              )
            )}
            {isStreaming && <StreamingMessage content={streamingContent} />}
          </div>
        ) : null}
      </div>
    </div>
  );
}
