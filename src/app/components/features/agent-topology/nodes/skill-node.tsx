import { Lightning } from '@phosphor-icons/react';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';

export interface SkillNodeData {
  name: string;
  skillId: string | null;
  [key: string]: unknown;
}

function SkillNodeComponent({ data, selected }: NodeProps) {
  const { name } = data as SkillNodeData;

  return (
    <div
      style={{ width: 80, height: 50, overflow: 'visible' }}
      className="flex items-center justify-center"
    >
      <Handle
        type="target"
        position={Position.Top}
        id="target"
        style={{ opacity: 0, width: 1, height: 1 }}
      />

      <div
        className="flex h-full w-full items-center justify-center gap-1.5 rounded-full border-2 px-2"
        style={{
          backgroundColor: selected
            ? 'var(--accent-subtle, rgba(56, 139, 253, 0.15))'
            : 'var(--surface-subtle, rgba(56, 139, 253, 0.08))',
          borderColor: selected
            ? 'var(--accent-default, #388bfd)'
            : 'var(--accent-muted, rgba(56, 139, 253, 0.4))',
          transition: 'background-color 200ms, border-color 200ms',
        }}
      >
        <Lightning
          className="h-3.5 w-3.5 shrink-0"
          weight="fill"
          style={{ color: 'var(--accent-default, #388bfd)' }}
        />
        <span
          className="truncate text-[10px] font-medium leading-tight"
          style={{ color: 'var(--fg-default)' }}
        >
          {name}
        </span>
      </div>
    </div>
  );
}

function areSkillNodePropsEqual(prev: NodeProps, next: NodeProps): boolean {
  if (prev.selected !== next.selected) return false;
  const prevData = prev.data as SkillNodeData;
  const nextData = next.data as SkillNodeData;
  return prevData.name === nextData.name && prevData.skillId === nextData.skillId;
}

export const SkillNode = memo(SkillNodeComponent, areSkillNodePropsEqual);
SkillNode.displayName = 'SkillNode';
