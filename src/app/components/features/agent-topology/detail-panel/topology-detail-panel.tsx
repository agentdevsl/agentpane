import { Lightning, X } from '@phosphor-icons/react';
import { useState } from 'react';
import type { TopologyNode } from '@/lib/topology/types';
import { cn } from '@/lib/utils/cn';
import { getRoleConfig, STATUS_COLORS } from '../nodes/agent-node-types';
import { ActivityTab } from './activity-tab';
import { DecisionsTab } from './decisions-tab';
import { DetailsTab } from './details-tab';

type DetailTab = 'details' | 'decisions' | 'activity';

interface TopologyDetailPanelProps {
  node: TopologyNode | null;
  allNodes: TopologyNode[];
  taskName: string;
  taskPriority: string;
  sessionId?: string;
  onClose: () => void;
}

export function TopologyDetailPanel({
  node,
  allNodes,
  taskName,
  taskPriority,
  sessionId,
  onClose,
}: TopologyDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>('details');

  if (!node) return null;

  const isSkillNode = node.type === 'skill';
  const roleConfig = getRoleConfig(node.role);
  const statusColor = STATUS_COLORS[node.status];

  return (
    <div className="flex w-[360px] shrink-0 flex-col border-l border-border bg-surface">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        {isSkillNode ? (
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            style={{
              backgroundColor: 'var(--accent-subtle, rgba(56, 139, 253, 0.15))',
              color: 'var(--accent-default, #388bfd)',
            }}
          >
            <Lightning className="h-5 w-5" weight="fill" />
          </div>
        ) : (
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg"
            style={{ backgroundColor: `${roleConfig.color}22`, color: roleConfig.color }}
          >
            {roleConfig.icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">{node.name}</div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span>{isSkillNode ? 'Skill' : roleConfig.label}</span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: statusColor }}
              />
              {node.status}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-fg-muted hover:bg-surface-subtle hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border">
        {(['details', 'decisions', 'activity'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={cn(
              'flex-1 px-3 py-2 text-xs font-medium capitalize transition-colors',
              activeTab === tab ? 'border-b-2 border-accent text-fg' : 'text-fg-muted hover:text-fg'
            )}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'details' && (
          <DetailsTab
            node={node}
            allNodes={allNodes}
            taskName={taskName}
            taskPriority={taskPriority}
          />
        )}
        {activeTab === 'decisions' && <DecisionsTab decisions={node.decisions} />}
        {activeTab === 'activity' && <ActivityTab node={node} sessionId={sessionId} />}
      </div>
    </div>
  );
}
