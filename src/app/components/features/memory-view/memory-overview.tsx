import { ChartBar, Lightbulb, Sparkle, SunHorizon } from '@phosphor-icons/react';
import type React from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useMemory } from './memory-context';

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-fg-muted text-xs font-medium uppercase tracking-wider">
        <Icon className="h-4 w-4" /> {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-fg">{value}</div>
    </div>
  );
}

export function MemoryOverview(): React.JSX.Element {
  const {
    health,
    insights,
    skillMetrics,
    dreamSessions,
    suggestions,
    setActiveTab,
    triggerDream,
    isDreamRunning,
  } = useMemory();

  const isAvailable = health?.available ?? false;
  const insightCount = health?.insightCount ?? insights.length;
  const pendingCount = suggestions.filter((s) => s.status === 'pending').length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-block h-2.5 w-2.5 rounded-full',
            isAvailable ? 'bg-success' : 'bg-danger'
          )}
        />
        <span className="text-sm font-medium text-fg">
          {isAvailable ? 'Memory Available' : 'Memory Unavailable'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard icon={Lightbulb} label="Total Insights" value={insightCount} />
        <StatCard icon={ChartBar} label="Active Skills" value={skillMetrics.length} />
        <StatCard icon={SunHorizon} label="Dream Sessions" value={dreamSessions.length} />
        <StatCard icon={Sparkle} label="Pending Suggestions" value={pendingCount} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg-muted">Quick Actions</h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="default" size="sm" onClick={() => setActiveTab('insights')}>
            Create Insight
          </Button>
          <Button variant="outline" size="sm" onClick={() => setActiveTab('skills')}>
            View Skills
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isDreamRunning}
            onClick={() => void triggerDream()}
          >
            {isDreamRunning ? 'Dream Running...' : 'Trigger Dream'}
          </Button>
        </div>
      </div>
    </div>
  );
}
