import { Cube, CubeTransparent } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';

const executionBadgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap',
  {
    variants: {
      size: {
        compact: 'px-2 py-0.5 text-[10px]',
        full: 'px-2.5 py-1 text-xs',
      },
      provider: {
        kubernetes: 'bg-accent/15 text-accent',
        docker: 'bg-done/15 text-done',
      },
    },
    defaultVariants: {
      size: 'compact',
      provider: 'docker',
    },
  }
);

interface ExecutionBadgeProps {
  sandboxProvider?: string | null;
  sandboxContainerId?: string | null;
  size?: 'compact' | 'full';
}

export function ExecutionBadge({
  sandboxProvider,
  sandboxContainerId,
  size = 'compact',
}: ExecutionBadgeProps) {
  if (!sandboxProvider) return null;

  const isK8s = sandboxProvider === 'kubernetes';
  const provider = isK8s ? 'kubernetes' : 'docker';
  const Icon = isK8s ? CubeTransparent : Cube;
  const iconSize = size === 'compact' ? 10 : 12;

  let label: string;
  if (!sandboxContainerId) {
    label = isK8s ? 'Kubernetes' : 'Docker';
  } else if (isK8s) {
    label =
      size === 'compact'
        ? (sandboxContainerId.split('-').slice(-1)[0] ?? sandboxContainerId)
        : sandboxContainerId;
  } else {
    label = sandboxContainerId.slice(0, 12);
  }

  const tooltip = sandboxContainerId
    ? isK8s
      ? `Pod: ${sandboxContainerId}`
      : `Container: ${sandboxContainerId}`
    : isK8s
      ? 'Kubernetes sandbox'
      : 'Docker sandbox';

  return (
    <span className={executionBadgeVariants({ size, provider })} title={tooltip}>
      <Icon size={iconSize} weight="duotone" />
      {label}
    </span>
  );
}
