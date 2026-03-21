import {
  FileCode,
  FileCss,
  FileHtml,
  FileJs,
  FileMd,
  FileMinus,
  FilePlus,
  FileText,
  FileTs,
  PencilSimple,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useRef } from 'react';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import type { DiffFile, DiffFileStatus } from '@/lib/types/diff';
import { cn } from '@/lib/utils/cn';

/**
 * CVA variants for file tab styling
 */
const fileTabVariants = cva(
  [
    'group relative flex shrink-0 items-center gap-2 px-4 py-2.5 text-[13px] font-mono',
    'whitespace-nowrap border-b-2 transition duration-fast ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
  ].join(' '),
  {
    variants: {
      active: {
        true: 'border-accent text-fg bg-transparent',
        false: 'border-transparent text-fg-muted hover:bg-surface-muted hover:text-fg',
      },
    },
    defaultVariants: {
      active: false,
    },
  }
);

/**
 * CVA variants for file status indicator
 */
const fileStatusIndicatorVariants = cva('flex h-4 w-4 items-center justify-center', {
  variants: {
    status: {
      added: 'text-[var(--syntax-added)]',
      deleted: 'text-[var(--syntax-removed)]',
      modified: 'text-attention',
      renamed: 'text-accent',
    },
  },
  defaultVariants: {
    status: 'modified',
  },
});

interface FileTabsProps {
  files: DiffFile[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

/**
 * Per-file navigation with:
 * - Tab for each changed file
 * - File icons based on extension
 * - Change count per file (+/-)
 * - Scrollable tab list for many files
 */
export function FileTabs({ files, activeIndex, onSelect }: FileTabsProps): React.JSX.Element {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  // Auto-scroll to active tab when it changes
  useMountEffect(() => {
    if (activeTabRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const tab = activeTabRef.current;
      const containerRect = container.getBoundingClientRect();
      const tabRect = tab.getBoundingClientRect();

      if (tabRect.left < containerRect.left) {
        container.scrollLeft -= containerRect.left - tabRect.left + 16;
      } else if (tabRect.right > containerRect.right) {
        container.scrollLeft += tabRect.right - containerRect.right + 16;
      }
    }
  });

  // Keyboard navigation
  const handleKeyDown = (event: React.KeyboardEvent, currentIndex: number) => {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        if (currentIndex > 0) {
          onSelect(currentIndex - 1);
        }
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (currentIndex < files.length - 1) {
          onSelect(currentIndex + 1);
        }
        break;
      case 'Home':
        event.preventDefault();
        onSelect(0);
        break;
      case 'End':
        event.preventDefault();
        onSelect(files.length - 1);
        break;
    }
  };

  return (
    <div
      ref={scrollContainerRef}
      className="flex gap-0 overflow-x-auto border-b border-border bg-surface-subtle scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border"
      role="tablist"
      aria-label="Changed files"
      data-testid="file-tabs"
    >
      {files.map((file, index) => {
        const isActive = index === activeIndex;
        const fileName = file.path.split('/').pop() || file.path;
        const FileIcon = getFileIcon(file.path);
        const StatusIcon = getStatusIcon(file.status);

        return (
          <button
            key={file.path}
            ref={isActive ? activeTabRef : undefined}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`diff-panel-${index}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(index)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={fileTabVariants({ active: isActive })}
            data-testid={`file-tab-${index}`}
          >
            {/* File status indicator */}
            <span className={fileStatusIndicatorVariants({ status: file.status })}>
              <StatusIcon className="h-3.5 w-3.5" weight="bold" />
            </span>

            {/* File type icon */}
            <FileIcon
              className={cn('h-4 w-4 shrink-0', isActive ? 'text-fg-muted' : 'text-fg-subtle')}
              weight="regular"
            />

            {/* File name */}
            <span className="max-w-48 truncate" title={file.path}>
              {fileName}
            </span>

            {/* Change count badges */}
            <span className="flex items-center gap-1 text-xs">
              {file.additions > 0 && (
                <span className="text-[var(--syntax-added)]" data-testid="tab-additions">
                  +{file.additions}
                </span>
              )}
              {file.deletions > 0 && (
                <span className="text-[var(--syntax-removed)]" data-testid="tab-deletions">
                  -{file.deletions}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Get the appropriate file icon based on file extension
 */
function getFileIcon(
  path: string
): React.ComponentType<{ className?: string; weight?: 'regular' | 'bold' }> {
  const ext = path.split('.').pop()?.toLowerCase() || '';

  const iconMap: Record<
    string,
    React.ComponentType<{ className?: string; weight?: 'regular' | 'bold' }>
  > = {
    // TypeScript
    ts: FileTs,
    tsx: FileTs,
    mts: FileTs,
    cts: FileTs,
    // JavaScript
    js: FileJs,
    jsx: FileJs,
    mjs: FileJs,
    cjs: FileJs,
    // HTML
    html: FileHtml,
    htm: FileHtml,
    // CSS
    css: FileCss,
    scss: FileCss,
    sass: FileCss,
    less: FileCss,
    // Markdown
    md: FileMd,
    mdx: FileMd,
    // JSON/Config
    json: FileCode,
    yaml: FileCode,
    yml: FileCode,
    toml: FileCode,
  };

  return iconMap[ext] || FileCode;
}

/**
 * Get the appropriate status icon based on file status
 */
function getStatusIcon(
  status: DiffFileStatus
): React.ComponentType<{ className?: string; weight?: 'regular' | 'bold' }> {
  switch (status) {
    case 'added':
      return FilePlus;
    case 'deleted':
      return FileMinus;
    case 'renamed':
      return PencilSimple;
    default:
      return FileText;
  }
}

/**
 * Compact file tabs for smaller spaces
 */
export function CompactFileTabs({
  files,
  activeIndex,
  onSelect,
}: FileTabsProps): React.JSX.Element {
  return (
    <div
      className="flex flex-wrap gap-1 p-2 bg-surface-subtle border-b border-border"
      role="tablist"
      aria-label="Changed files"
      data-testid="compact-file-tabs"
    >
      {files.map((file, index) => {
        const isActive = index === activeIndex;
        const fileName = file.path.split('/').pop() || file.path;
        const StatusIcon = getStatusIcon(file.status);

        return (
          <button
            key={file.path}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(index)}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1 text-xs font-mono',
              'transition duration-fast ease-out',
              isActive
                ? 'bg-accent-muted text-accent'
                : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
            )}
            title={file.path}
            data-testid={`compact-file-tab-${index}`}
          >
            <StatusIcon
              className={cn(
                'h-3 w-3',
                file.status === 'added' && 'text-[var(--syntax-added)]',
                file.status === 'deleted' && 'text-[var(--syntax-removed)]',
                file.status === 'modified' && 'text-attention',
                file.status === 'renamed' && 'text-accent'
              )}
              weight="bold"
            />
            <span className="max-w-24 truncate">{fileName}</span>
          </button>
        );
      })}
    </div>
  );
}
