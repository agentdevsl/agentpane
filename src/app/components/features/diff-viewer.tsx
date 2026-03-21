import { CaretDown, CaretRight, FileCode, SpinnerGap } from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { DiffFile } from '@/lib/types/diff';
import { cn } from '@/lib/utils/cn';
import { CompactChangesSummary } from './approval-dialog/changes-summary';
import { CompactFileTabs } from './approval-dialog/file-tabs';

interface WorktreeDiffResponse {
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
    hunks: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      content: string;
    }>;
  }>;
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

interface WorktreeDiffViewerProps {
  worktreeId: string;
}

// --- Parsed line types ---

type ParsedLineType = 'addition' | 'deletion' | 'context';

interface ParsedLine {
  type: ParsedLineType;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

interface ParsedHunk {
  header: string;
  lines: ParsedLine[];
}

/**
 * Parse raw unified diff hunk content into structured lines with line numbers.
 */
function parseHunkContent(content: string, oldStart: number, newStart: number): ParsedLine[] {
  const rawLines = content.split('\n');
  const lines: ParsedLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? '';
    if (raw.startsWith('@@')) continue; // Skip hunk header if present in content
    if (raw === '' && i === rawLines.length - 1) continue; // Skip trailing empty

    if (raw.startsWith('+')) {
      lines.push({
        type: 'addition',
        content: raw.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine++,
      });
    } else if (raw.startsWith('-')) {
      lines.push({
        type: 'deletion',
        content: raw.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: null,
      });
    } else {
      // Context line (may start with space or be bare)
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      lines.push({
        type: 'context',
        content: text,
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      });
    }
  }

  return lines;
}

/**
 * Fetches and renders a structured diff from a worktree.
 * Uses CSS Grid layout with bar indicators and sticky line numbers,
 * inspired by diffs.com design philosophy.
 */
export function WorktreeDiffViewer({ worktreeId }: WorktreeDiffViewerProps): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [parsedHunks, setParsedHunks] = useState<Map<string, ParsedHunk[]>>(new Map());
  const [stats, setStats] = useState<{
    filesChanged: number;
    additions: number;
    deletions: number;
  } | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);

  const fetchDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/worktrees/${worktreeId}/diff`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as WorktreeDiffResponse;

      // Map API response to DiffFile type and parse hunk content
      const mapped: DiffFile[] = [];
      const hunksMap = new Map<string, ParsedHunk[]>();

      for (const f of data.files) {
        mapped.push({
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          hunks: f.hunks.map((h) => ({
            header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
            oldStart: h.oldStart,
            oldLines: h.oldLines,
            newStart: h.newStart,
            newLines: h.newLines,
            lines: [],
          })),
        });

        // Parse hunk content into structured lines
        hunksMap.set(
          f.path,
          f.hunks.map((h) => ({
            header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
            lines: parseHunkContent(h.content, h.oldStart, h.newStart),
          }))
        );
      }

      setFiles(mapped);
      setParsedHunks(hunksMap);
      setStats(data.stats);
      setSelectedFileIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [worktreeId]);

  useWatchEffect(() => {
    void fetchDiff();
  }, [fetchDiff]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-8 text-fg-muted">
        <SpinnerGap className="h-5 w-5 animate-spin" />
        <span>Loading diff...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-danger">
        <p>Failed to load diff: {error}</p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-fg-muted">
        <FileCode className="h-8 w-8 text-fg-subtle" weight="regular" />
        <p>No changes detected</p>
      </div>
    );
  }

  const selectedFile = files[selectedFileIndex];
  const selectedHunks = selectedFile ? (parsedHunks.get(selectedFile.path) ?? []) : [];

  return (
    <div className="flex flex-1 flex-col min-h-0" data-testid="worktree-diff-viewer">
      {/* Summary bar */}
      {stats && (
        <div className="border-b border-border px-4 py-2">
          <CompactChangesSummary summary={stats} />
        </div>
      )}

      {/* File tabs */}
      <div className="border-b border-border">
        <CompactFileTabs
          files={files}
          activeIndex={selectedFileIndex}
          onSelect={setSelectedFileIndex}
        />
      </div>

      {/* Diff content */}
      <div className="flex-1 min-h-0 overflow-auto bg-canvas">
        {selectedFile && <DiffFileContent file={selectedFile} hunks={selectedHunks} />}
      </div>
    </div>
  );
}

// --- Diff file content renderer ---

function DiffFileContent({
  file,
  hunks,
}: {
  file: DiffFile;
  hunks: ParsedHunk[];
}): React.JSX.Element {
  if (file.isBinary) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-8 text-fg-muted">
        <FileCode className="h-8 w-8 text-fg-subtle" weight="regular" />
        <p>Binary file not shown</p>
      </div>
    );
  }

  if (hunks.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-fg-muted">
        <FileCode className="h-8 w-8 text-fg-subtle" weight="regular" />
        <p>No changes in this file</p>
      </div>
    );
  }

  return (
    <div className="font-mono text-[13px] leading-6" data-testid="diff-content">
      {hunks.map((hunk, i) => (
        <DiffHunkBlock key={`${hunk.header}-${i}`} hunk={hunk} />
      ))}
    </div>
  );
}

// --- Hunk block with collapsible header ---

function DiffHunkBlock({ hunk }: { hunk: ParsedHunk }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);

  const { additions, deletions } = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const line of hunk.lines) {
      if (line.type === 'addition') add++;
      if (line.type === 'deletion') del++;
    }
    return { additions: add, deletions: del };
  }, [hunk.lines]);

  return (
    <div
      className="border-t border-border first:border-t-0"
      data-testid="diff-hunk"
      data-expanded={expanded}
    >
      {/* Hunk header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-1.5 text-left font-mono text-xs',
          'bg-accent-muted/15 text-accent transition duration-fast',
          'hover:bg-accent-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset'
        )}
        aria-expanded={expanded}
        aria-label={`Toggle hunk: ${hunk.header}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-muted">
          {expanded ? (
            <CaretDown className="h-3 w-3" weight="bold" />
          ) : (
            <CaretRight className="h-3 w-3" weight="bold" />
          )}
        </span>
        <span
          className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          data-testid="hunk-header"
        >
          {hunk.header}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-fg-subtle">
          {additions > 0 && <span className="text-[var(--syntax-added)]">+{additions}</span>}
          {deletions > 0 && <span className="text-[var(--syntax-removed)]">-{deletions}</span>}
          <span>{hunk.lines.length} lines</span>
        </span>
      </button>

      {/* Hunk lines - CSS Grid layout */}
      {expanded && (
        <div className="diff-grid" data-testid="hunk-content">
          {hunk.lines.map((line, idx) => (
            <DiffLineRow
              key={`${line.type}-${line.oldLineNumber ?? line.newLineNumber ?? idx}-${idx}`}
              line={line}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Individual diff line using CSS Grid + bar indicator ---

function DiffLineRow({ line }: { line: ParsedLine }): React.JSX.Element {
  return (
    <div
      className={cn(
        'diff-line',
        line.type === 'addition' && 'diff-line-added',
        line.type === 'deletion' && 'diff-line-deleted',
        line.type === 'context' && 'diff-line-context'
      )}
      data-line-type={line.type}
    >
      {/* Bar indicator - colored left border */}
      <span
        className={cn(
          'diff-bar',
          line.type === 'addition' && 'bg-[var(--syntax-added)]',
          line.type === 'deletion' && 'bg-[var(--syntax-removed)]'
        )}
        aria-hidden="true"
      />

      {/* Old line number */}
      <span className="diff-line-number" data-line-type={line.type}>
        {line.oldLineNumber ?? ''}
      </span>

      {/* New line number */}
      <span className="diff-line-number" data-line-type={line.type}>
        {line.newLineNumber ?? ''}
      </span>

      {/* Line content */}
      <span className="diff-line-content" data-line-type={line.type}>
        {line.content}
      </span>
    </div>
  );
}
