import type React from 'react';

interface SuggestionDiffViewProps {
  diff: string | null;
  currentContent: string | null;
  suggestedContent: string;
}

function DiffBlock({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split('\n');

  return (
    <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs font-mono">
      {lines.map((line, index) => {
        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
          return (
            <div key={index} className="text-fg-subtle font-semibold">
              {line}
            </div>
          );
        }
        if (line.startsWith('-')) {
          return (
            <div key={index} className="bg-danger-subtle text-danger">
              {line}
            </div>
          );
        }
        if (line.startsWith('+')) {
          return (
            <div key={index} className="bg-success-subtle text-success">
              {line}
            </div>
          );
        }
        return (
          <div key={index} className="text-fg-muted">
            {line}
          </div>
        );
      })}
    </pre>
  );
}

function SideBySideView({
  currentContent,
  suggestedContent,
}: {
  currentContent: string;
  suggestedContent: string;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">Current</div>
        <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs font-mono text-fg-muted">
          {currentContent}
        </pre>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">Suggested</div>
        <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs font-mono text-fg">
          {suggestedContent}
        </pre>
      </div>
    </div>
  );
}

export function SuggestionDiffView({
  diff,
  currentContent,
  suggestedContent,
}: SuggestionDiffViewProps): React.JSX.Element {
  if (diff) {
    return <DiffBlock diff={diff} />;
  }

  if (currentContent) {
    return <SideBySideView currentContent={currentContent} suggestedContent={suggestedContent} />;
  }

  return (
    <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs font-mono text-fg">
      {suggestedContent}
    </pre>
  );
}
