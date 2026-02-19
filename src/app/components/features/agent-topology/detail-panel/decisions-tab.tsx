import type { TopologyDecision } from '@/lib/topology/types';
import { DECISION_TYPE_CONFIG } from '../nodes/agent-node-types';

interface DecisionsTabProps {
  decisions: TopologyDecision[];
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function DecisionsTab({ decisions }: DecisionsTabProps) {
  if (decisions.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center">
        <span className="text-xs text-fg-muted">No decisions recorded</span>
      </div>
    );
  }

  const sorted = [...decisions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);

  return (
    <div className="space-y-3 p-4">
      {sorted.map((decision) => {
        const config = DECISION_TYPE_CONFIG[decision.type];
        return (
          <div key={decision.id} className="flex gap-3">
            <div
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs"
              style={{ backgroundColor: `${config.color}22`, color: config.color }}
            >
              {config.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-fg">{config.label}</div>
              <div className="text-xs text-fg-muted">{decision.summary}</div>
              <div className="mt-0.5 text-xs text-fg-subtle">
                {relativeTime(decision.timestamp)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
