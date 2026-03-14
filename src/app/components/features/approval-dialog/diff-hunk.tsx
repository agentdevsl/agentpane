import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useState } from 'react';
import type { DiffHunk as DiffHunkType } from '@/lib/types/diff';
import { cn } from '@/lib/utils/cn';
import { DiffLine } from './diff-line';

/**
 * CVA variants for hunk header button
 */
const hunkHeaderVariants = cva(
  [
    'flex w-full items-center gap-2 px-4 py-2 text-left font-mono text-xs',
    'bg-accent-muted/15 text-accent transition duration-fast ease-out',
    'hover:bg-accent-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
  ].join(' '),
  {
    variants: {
      expanded: {
        true: '',
        false: '',
      },
    },
    defaultVariants: {
      expanded: true,
    },
  }
);

interface DiffHunkProps {
  hunk: DiffHunkType;
  defaultExpanded?: boolean;
}

/**
 * Individual hunk display with:
 * - Hunk header (@@ -x,y +x,y @@)
 * - Context lines
 * - Addition/deletion lines
 * - Expand/collapse control
 */
export function DiffHunk({ hunk, defaultExpanded = true }: DiffHunkProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const toggleExpanded = () => setIsExpanded(!isExpanded);

  // Count additions and deletions in this hunk
  const additions = hunk.lines.filter((line) => line.type === 'addition').length;
  const deletions = hunk.lines.filter((line) => line.type === 'deletion').length;

  return (
    <div
      className="border-t border-border first:border-t-0"
      data-testid="diff-hunk"
      data-expanded={isExpanded}
    >
      {/* Hunk header */}
      <button
        type="button"
        onClick={toggleExpanded}
        className={hunkHeaderVariants({ expanded: isExpanded })}
        aria-expanded={isExpanded}
        aria-label={`Toggle hunk visibility: ${hunk.header || `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}`}
      >
        {/* Expand/collapse icon */}
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-muted">
          {isExpanded ? (
            <CaretDown className="h-3 w-3" weight="bold" />
          ) : (
            <CaretRight className="h-3 w-3" weight="bold" />
          )}
        </span>

        {/* Hunk header text */}
        <span
          className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          data-testid="hunk-header"
        >
          {hunk.header ||
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
        </span>

        {/* Hunk stats */}
        <span className="flex shrink-0 items-center gap-2 text-fg-subtle">
          {additions > 0 && (
            <span className="text-[var(--syntax-added)]" data-testid="hunk-additions">
              +{additions}
            </span>
          )}
          {deletions > 0 && (
            <span className="text-[var(--syntax-removed)]" data-testid="hunk-deletions">
              -{deletions}
            </span>
          )}
          <span className="text-fg-subtle">{hunk.lines.length} lines</span>
        </span>
      </button>

      {/* Hunk content */}
      {isExpanded && (
        <div className="font-mono text-[13px] leading-6" data-testid="hunk-content">
          {hunk.lines.map((line, lineIndex) => {
            return (
              <DiffLine
                key={`${line.type}-${line.oldLineNumber ?? line.newLineNumber ?? lineIndex}-${lineIndex}`}
                line={line}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsed hunk placeholder showing how many lines are hidden
 */
export function CollapsedHunkPlaceholder({
  lineCount,
  onExpand,
}: {
  lineCount: number;
  onExpand: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onExpand}
      className={cn(
        'flex w-full items-center justify-center gap-2 py-1',
        'bg-surface-subtle text-xs text-fg-muted',
        'hover:bg-surface-muted hover:text-fg transition duration-fast ease-out'
      )}
    >
      <span className="flex items-center gap-1">
        <CaretDown className="h-3 w-3" weight="bold" />
        Expand {lineCount} hidden lines
      </span>
    </button>
  );
}
