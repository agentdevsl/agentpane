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
      style={{ width: 200, height: 64, overflow: 'visible' }}
      className="flex items-center justify-center"
    >
      <Handle
        type="target"
        position={Position.Top}
        id="target"
        style={{ opacity: 0, width: 1, height: 1 }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="source"
        style={{ opacity: 0, width: 1, height: 1 }}
      />

      <div
        className="flex h-full w-full items-center justify-center gap-1.5 rounded-full border-2 px-2 shadow-sm"
        style={{
          // Solid accent fill with high-contrast foreground so the skill
          // pill stays legible against both the dark canvas and the
          // tinted cluster boxes underneath.
          backgroundColor: selected
            ? 'var(--accent-emphasis, var(--accent-default, #1f6feb))'
            : 'color-mix(in srgb, var(--accent-default, #388bfd) 35%, var(--bg-canvas, #0d1117))',
          borderColor: 'var(--accent-default, #388bfd)',
          transition: 'background-color 200ms, border-color 200ms',
        }}
      >
        <Lightning
          className="h-4 w-4 shrink-0"
          weight="fill"
          style={{ color: 'var(--accent-fg, var(--accent-default, #388bfd))' }}
        />
        <span
          className="truncate text-xs font-semibold leading-tight"
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
