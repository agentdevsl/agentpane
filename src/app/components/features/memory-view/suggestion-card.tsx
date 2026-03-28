import { Check, PencilSimple, X } from '@phosphor-icons/react';
import type React from 'react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { SuggestionDiffView } from './suggestion-diff-view';

import type { SkillSuggestion } from './types';

export interface SuggestionCardProps {
  suggestion: SkillSuggestion;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onModify: (id: string) => void;
}

const TYPE_BADGE_STYLES: Record<string, string> = {
  improve_prompt: 'bg-accent-subtle text-accent',
  add_example: 'bg-success-subtle text-success',
  fix_pattern: 'bg-attention-subtle text-attention',
  new_skill: 'bg-done-subtle text-done',
};

const STATUS_BADGE_STYLES: Record<string, string> = {
  pending: 'bg-attention-subtle text-attention',
  accepted: 'bg-success-subtle text-success',
  rejected: 'bg-danger-subtle text-danger',
  modified: 'bg-accent-subtle text-accent',
};

const TYPE_LABELS: Record<string, string> = {
  improve_prompt: 'Improve Prompt',
  add_example: 'Add Example',
  fix_pattern: 'Fix Pattern',
  new_skill: 'New Skill',
};

function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function SuggestionCard({
  suggestion,
  onAccept,
  onReject,
  onModify,
}: SuggestionCardProps): React.JSX.Element {
  const [showChanges, setShowChanges] = useState(false);

  const typeBadgeClass =
    TYPE_BADGE_STYLES[suggestion.suggestionType] ?? 'bg-surface-muted text-fg-muted';
  const statusBadgeClass =
    STATUS_BADGE_STYLES[suggestion.status] ?? 'bg-surface-muted text-fg-muted';
  const typeLabel = TYPE_LABELS[suggestion.suggestionType] ?? suggestion.suggestionType;

  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface p-4 transition-all duration-200',
        showChanges ? 'shadow-sm' : 'hover:border-fg-subtle hover:shadow-md'
      )}
      style={
        showChanges
          ? { background: 'linear-gradient(135deg, rgba(88,166,255,0.04) 0%, transparent 60%)' }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{suggestion.title}</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                typeBadgeClass
              )}
            >
              {typeLabel}
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                statusBadgeClass
              )}
            >
              {formatStatus(suggestion.status)}
            </span>
          </div>
          <span className="text-xs text-fg-muted">{suggestion.skillName}</span>
        </div>
      </div>

      <p className="mt-2.5 text-sm leading-relaxed text-fg-muted">{suggestion.reasoning}</p>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowChanges((prev: boolean) => !prev)}
          className="text-xs font-medium text-accent hover:underline"
          aria-expanded={showChanges}
        >
          {showChanges ? 'Hide changes' : 'Show changes'}
        </button>

        {/* Smooth expand/collapse for diff */}
        <div
          className={cn(
            'grid transition-all duration-200 ease-out',
            showChanges ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className="overflow-hidden">
            <div className="mt-2">
              <SuggestionDiffView
                diff={suggestion.diff}
                currentContent={suggestion.currentContent}
                suggestedContent={suggestion.suggestedContent}
              />
            </div>
          </div>
        </div>
      </div>

      {suggestion.userNotes && (
        <div className="mt-3 rounded-lg bg-surface-subtle p-2.5 text-xs text-fg-muted">
          <span className="font-medium">Notes:</span> {suggestion.userNotes}
        </div>
      )}

      {suggestion.status === 'pending' && (
        <div className="mt-3 flex items-center gap-2 border-t border-border-muted/50 pt-3">
          <Button
            variant="default"
            size="sm"
            className="bg-success hover:bg-success-hover gap-1"
            onClick={() => onAccept(suggestion.id)}
          >
            <Check size={14} weight="bold" />
            Accept
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-danger hover:border-danger hover:text-danger"
            onClick={() => onReject(suggestion.id)}
          >
            <X size={14} weight="bold" />
            Reject
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => onModify(suggestion.id)}
          >
            <PencilSimple size={14} />
            Modify
          </Button>
        </div>
      )}
    </div>
  );
}
