import { cva, type VariantProps } from 'class-variance-authority';

/**
 * Column container styles
 */
export const columnVariants = cva(
  'flex flex-col rounded-md border-2 border-border bg-surface transition-all duration-200',
  {
    variants: {
      state: {
        default: 'border-transparent',
        dropTarget: 'bg-primary/5 border-primary/20 shadow-inner',
        collapsed: 'w-12 min-w-12 border-transparent',
      },
    },
    defaultVariants: {
      state: 'default',
    },
  }
);

export type ColumnVariants = VariantProps<typeof columnVariants>;

/**
 * Card container styles
 */
export const cardVariants = cva(
  'rounded-md border bg-surface p-3 cursor-grab transition-all duration-150',
  {
    variants: {
      state: {
        default: 'border-border hover:border-fg-subtle',
        selected: 'border-accent bg-accent-muted',
        dragging: 'opacity-40 cursor-grabbing',
      },
    },
    defaultVariants: {
      state: 'default',
    },
  }
);

export type CardVariants = VariantProps<typeof cardVariants>;

/**
 * Priority indicator color styles (used with PriorityIcon component)
 */
export const priorityColorVariants = cva('shrink-0', {
  variants: {
    priority: {
      high: 'text-danger',
      medium: 'text-attention',
      low: 'text-success',
    },
  },
  defaultVariants: {
    priority: 'medium',
  },
});

export type PriorityColorVariants = VariantProps<typeof priorityColorVariants>;

/**
 * @deprecated Use PriorityIcon component instead
 */
export const priorityVariants = cva('w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/10', {
  variants: {
    priority: {
      high: 'bg-danger',
      medium: 'bg-attention',
      low: 'bg-success',
    },
  },
  defaultVariants: {
    priority: 'medium',
  },
});

export type PriorityVariants = VariantProps<typeof priorityVariants>;

/**
 * Label pill styles
 */
export const labelVariants = cva(
  'text-xs font-medium px-2 py-0.5 rounded-full uppercase tracking-wider',
  {
    variants: {
      type: {
        bug: 'bg-danger-muted text-danger',
        feature: 'bg-done-muted text-done',
        enhancement: 'bg-accent-muted text-accent',
        docs: 'bg-attention-muted text-attention',
        default: 'bg-surface-muted text-fg-muted',
      },
    },
    defaultVariants: {
      type: 'default',
    },
  }
);

export type LabelVariants = VariantProps<typeof labelVariants>;

/**
 * Column icon badge container styles
 * 24x24px container with 6px border-radius, 12% opacity background
 */
export const columnIconVariants = cva('w-6 h-6 rounded-[6px] flex items-center justify-center', {
  variants: {
    column: {
      backlog: 'bg-[rgba(139,148,158,0.12)] text-[#8b949e]',
      queued: 'bg-[rgba(88,166,255,0.12)] text-[#58a6ff]',
      in_progress: 'bg-[rgba(210,153,34,0.12)] text-[#d29922]',
      waiting_approval: 'bg-[rgba(163,113,247,0.12)] text-[#a371f7]',
      verified: 'bg-[rgba(63,185,80,0.12)] text-[#3fb950]',
    },
  },
  defaultVariants: {
    column: 'backlog',
  },
});

export type ColumnIconVariants = VariantProps<typeof columnIconVariants>;

/**
 * Agent status badge styles
 */
export const agentStatusVariants = cva('flex items-center gap-1.5 px-2 py-1 rounded text-xs mt-2', {
  variants: {
    status: {
      running: 'bg-attention-muted text-attention',
      paused: 'bg-accent-muted text-accent',
      idle: 'bg-surface-muted text-fg-muted',
    },
  },
  defaultVariants: {
    status: 'idle',
  },
});

export type AgentStatusVariants = VariantProps<typeof agentStatusVariants>;

/**
 * Last agent run status badge styles
 */
export const lastRunStatusVariants = cva(
  'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
  {
    variants: {
      status: {
        completed: 'bg-done-muted text-done',
        cancelled: 'bg-surface-muted text-fg-muted',
        error: 'bg-danger-muted text-danger',
        turn_limit: 'bg-attention-muted text-attention',
        planning: 'bg-secondary-muted text-secondary',
      },
    },
    defaultVariants: {
      status: 'completed',
    },
  }
);

export type LastRunStatusVariants = VariantProps<typeof lastRunStatusVariants>;

/**
 * Task mode badge styles
 */
export const modeBadgeVariants = cva(
  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide',
  {
    variants: {
      mode: {
        plan: 'bg-secondary-muted text-secondary',
        implement: 'bg-accent-muted text-accent',
      },
    },
    defaultVariants: {
      mode: 'implement',
    },
  }
);

export type ModeBadgeVariants = VariantProps<typeof modeBadgeVariants>;
