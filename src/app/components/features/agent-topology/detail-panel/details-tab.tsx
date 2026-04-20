import { Lightning } from '@phosphor-icons/react';
import type { TopologyNode } from '@/lib/topology/types';
import { getRoleConfig, STATUS_COLORS } from '../nodes/agent-node-types';

interface DetailsTabProps {
  node: TopologyNode;
  allNodes: TopologyNode[];
  taskName: string;
  taskPriority: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
  P0: { bg: '#F8717122', text: '#F87171' },
  P1: { bg: '#FCA57222', text: '#FCA572' },
  P2: { bg: '#FFD86622', text: '#FFD866' },
  P3: { bg: '#34D39922', text: '#34D399' },
};

export function DetailsTab({ node, allNodes, taskName, taskPriority }: DetailsTabProps) {
  const statusColor = STATUS_COLORS[node.status];
  const priorityColor = PRIORITY_COLORS[taskPriority] ?? { bg: '#47556922', text: '#475569' };

  const parent = node.parentId ? allNodes.find((n) => n.id === node.parentId) : null;
  const children = allNodes.filter((n) => n.parentId === node.id);

  const isSkillNode = node.type === 'skill';

  // For skill nodes, show a simplified view
  if (isSkillNode) {
    const dependentAgents = allNodes.filter(
      (n) => n.type === 'agent' && n.agentMeta?.skills?.includes(node.name)
    );
    return (
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Lightning className="h-4 w-4" weight="fill" style={{ color: 'var(--accent-default)' }} />
          <span className="text-sm font-semibold text-fg">{node.name}</span>
        </div>
        <div className="text-xs text-fg-muted">Skill dependency node</div>
        {dependentAgents.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-fg-muted">Used by agents</div>
            {dependentAgents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 text-xs">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: getRoleConfig(agent.role).color }}
                />
                <span className="text-fg">{agent.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {/* Task info chip */}
      <div className="flex items-center gap-2">
        <span className="truncate rounded-md bg-surface-subtle px-2 py-1 text-xs text-fg-muted">
          {taskName}
        </span>
        <span
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium"
          style={{ backgroundColor: priorityColor.bg, color: priorityColor.text }}
        >
          {taskPriority}
        </span>
      </div>

      {/* Progress section */}
      <div>
        <div className="text-2xl font-bold" style={{ color: statusColor }}>
          {node.progress}%
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-emphasis">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${node.progress}%`, backgroundColor: statusColor }}
          />
        </div>
        <div className="mt-1 text-xs text-fg-muted">{node.turns} turns</div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-surface-subtle p-3">
          <div className="text-xs text-fg-muted">Tokens</div>
          <div className="text-sm font-semibold text-fg">{formatTokens(node.tokens)}</div>
        </div>
        <div className="rounded-lg bg-surface-subtle p-3">
          <div className="text-xs text-fg-muted">Cost</div>
          <div className="text-sm font-semibold text-fg">${node.cost.toFixed(2)}</div>
        </div>
        <div className="rounded-lg bg-surface-subtle p-3">
          <div className="text-xs text-fg-muted">Messages</div>
          <div className="text-sm font-semibold text-fg">{node.messages}</div>
        </div>
        <div className="rounded-lg bg-surface-subtle p-3">
          <div className="text-xs text-fg-muted">Turns</div>
          <div className="text-sm font-semibold text-fg">{node.turns}</div>
        </div>
      </div>

      {/* Agent Configuration (from agentMeta) */}
      {node.agentMeta && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-fg-muted">Configuration</div>
          {node.agentMeta.model && (
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-surface-subtle px-2 py-0.5 text-xs font-mono text-fg">
                {node.agentMeta.model}
              </span>
            </div>
          )}
          {node.agentMeta.skills && node.agentMeta.skills.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] text-fg-subtle">Declared skills</div>
              <div className="flex flex-wrap gap-1">
                {node.agentMeta.skills.map((skill) => (
                  <span
                    key={skill}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: 'var(--accent-subtle, rgba(56, 139, 253, 0.1))',
                      color: 'var(--accent-default, #388bfd)',
                    }}
                  >
                    <Lightning className="h-2.5 w-2.5" weight="fill" />
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          )}
          {node.agentMeta.tools && node.agentMeta.tools.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] text-fg-subtle">Declared tools</div>
              <div className="flex flex-wrap gap-1">
                {node.agentMeta.tools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded-md bg-surface-subtle px-1.5 py-0.5 text-[10px] text-fg-muted"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Skills Invoked (from skillCalls) */}
      {node.skillCalls.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-fg-muted">Skills Invoked</div>
          <div className="flex flex-wrap gap-1">
            {node.skillCalls.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--accent-subtle, rgba(56, 139, 253, 0.1))',
                  color: 'var(--accent-default, #388bfd)',
                }}
              >
                <Lightning className="h-3 w-3" weight="fill" />
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Verification */}
      <div className="flex items-center gap-2 text-sm">
        {node.verified ? (
          <>
            <span className="text-green-400">{'\u2713'}</span>
            <span className="text-fg">Verified</span>
            <span className="text-fg-muted">({node.verificationScore}%)</span>
          </>
        ) : node.status === 'verifying' ? (
          <>
            <span className="text-yellow-400">{'\u231B'}</span>
            <span className="text-fg-muted">Verifying...</span>
          </>
        ) : (
          <>
            <span className="text-fg-subtle">{'\u25CB'}</span>
            <span className="text-fg-muted">Not verified</span>
          </>
        )}
      </div>

      {/* Relationships */}
      {(parent || children.length > 0) && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-fg-muted">Relationships</div>
          {parent && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-fg-muted">{'\u2190'}</span>
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: getRoleConfig(parent.role).color }}
              />
              <span className="text-fg">{parent.name}</span>
              <span className="text-fg-subtle">({getRoleConfig(parent.role).label})</span>
            </div>
          )}
          {children.map((child) => (
            <div key={child.id} className="flex items-center gap-2 text-xs">
              <span className="text-fg-muted">{'\u2192'}</span>
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: getRoleConfig(child.role).color }}
              />
              <span className="text-fg">{child.name}</span>
              <span className="text-fg-subtle">({getRoleConfig(child.role).label})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
