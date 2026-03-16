import { CurrencyDollar } from '@phosphor-icons/react';
import type { SessionSummaryProps } from '../types';
import { formatDuration, formatTokens } from '../utils/format-duration';

export function SessionSummary({ metrics }: SessionSummaryProps): React.JSX.Element {
  const hasTests = metrics.testsRun > 0;
  const allTestsPassed = hasTests && metrics.testsPassed === metrics.testsRun;

  return (
    <div
      className="shrink-0 border-t border-border bg-surface-subtle px-3 py-2 md:px-4"
      data-testid="session-summary"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="font-medium text-fg-muted">Summary</span>
        <span className="h-3 w-px bg-border" />

        <span className="text-fg-muted">
          Files <span className="font-medium text-fg">{metrics.filesModified}</span>
        </span>

        <span className="text-fg-muted">
          Lines <span className="font-medium text-success">+{metrics.linesAdded}</span>{' '}
          <span className="font-medium text-danger">-{metrics.linesRemoved}</span>
        </span>

        {hasTests ? (
          <span className="text-fg-muted">
            Tests{' '}
            <span className={`font-medium ${allTestsPassed ? 'text-success' : ''}`}>
              {metrics.testsPassed}/{metrics.testsRun}
            </span>
          </span>
        ) : null}

        <span className="text-fg-muted">
          Tokens <span className="font-medium text-fg">{formatTokens(metrics.tokensUsed)}</span>
        </span>

        <span className="text-fg-muted">
          Turns <span className="font-medium text-fg">{metrics.turnsUsed}</span>
        </span>

        <span className="text-fg-muted">
          Duration{' '}
          <span className="font-medium text-fg">
            {metrics.duration != null ? formatDuration(metrics.duration) : 'In progress'}
          </span>
        </span>

        {metrics.costUsd != null && metrics.costUsd > 0 ? (
          <span className="flex items-center gap-1 text-fg-muted">
            <CurrencyDollar className="h-3 w-3" />
            Cost <span className="font-medium text-fg">${metrics.costUsd.toFixed(3)}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
