import { Trash } from '@phosphor-icons/react';
import type React from 'react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { InsightSourceBadge } from './insight-source-badge';

interface InsightCardProps {
  insight: {
    id: string;
    content: string;
    source: string;
    tags: string[];
    createdAt: string;
    skillId: string | null;
  };
  onDelete: (id: string) => void | Promise<boolean>;
}

export function InsightCard({ insight, onDelete }: InsightCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <InsightSourceBadge source={insight.source} />
          <span className="text-xs text-fg-muted">
            {new Date(insight.createdAt).toLocaleDateString()}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-fg-muted hover:text-danger"
          onClick={() => onDelete(insight.id)}
        >
          <Trash className="h-3.5 w-3.5" />
        </Button>
      </div>

      <button
        type="button"
        className={cn(
          'mt-2 w-full cursor-pointer text-left text-sm text-fg',
          !expanded && 'line-clamp-4'
        )}
        onClick={() => setExpanded((prev: boolean) => !prev)}
      >
        {insight.content}
      </button>

      {insight.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {insight.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
