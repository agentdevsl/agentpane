import { getRoleConfig } from '../nodes/agent-node-types';

const LEGEND_ITEMS: Array<{ role: string; label: string }> = [
  { role: 'orchestrator', label: 'Orch' },
  { role: 'planner', label: 'Plan' },
  { role: 'coder', label: 'Code' },
  { role: 'reviewer', label: 'Review' },
  { role: 'tester', label: 'Test' },
  { role: 'scanner', label: 'Scan' },
  { role: 'deployer', label: 'Deploy' },
];

export function TopologyLegend() {
  return (
    <div className="absolute right-4 bottom-4 flex items-center gap-3 rounded-lg border border-border bg-surface/80 px-3 py-2 backdrop-blur-sm">
      {LEGEND_ITEMS.map(({ role, label }) => (
        <div key={role} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: getRoleConfig(role).color }}
          />
          <span className="text-[10px] text-fg-muted">{label}</span>
        </div>
      ))}
    </div>
  );
}
