import {
  ChatCircleText,
  Check,
  FolderSimple,
  ListChecks,
  MagnifyingGlass,
  Robot,
  RocketLaunch,
  Warning,
  WifiSlash,
} from '@phosphor-icons/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';

const emptyStateVariants = cva('flex flex-col items-center justify-center text-center', {
  variants: {
    size: {
      sm: 'gap-3 py-6 px-4 max-w-xs',
      md: 'gap-4 py-8 px-6 max-w-md',
      lg: 'gap-6 py-12 px-8 max-w-lg',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

const iconContainerVariants = cva(
  'flex items-center justify-center rounded-full border-2 border-dashed border-border-muted bg-bg-subtle',
  {
    variants: {
      size: {
        sm: 'h-16 w-16',
        md: 'h-24 w-24',
        lg: 'h-28 w-28',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  }
);

const iconVariants = cva('text-fg-subtle', {
  variants: {
    size: {
      sm: 'h-8 w-8',
      md: 'h-12 w-12', // 48px - close to 64px spec for md
      lg: 'h-16 w-16', // 64px
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

const titleVariants = cva('font-semibold text-fg', {
  variants: {
    size: {
      sm: 'text-base',
      md: 'text-lg',
      lg: 'text-xl',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

const subtitleVariants = cva('text-fg-muted leading-relaxed', {
  variants: {
    size: {
      sm: 'text-xs',
      md: 'text-sm',
      lg: 'text-base',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

type EmptyStatePreset =
  | 'first-run'
  | 'no-projects'
  | 'no-tasks'
  | 'no-agents'
  | 'empty-session'
  | 'no-results'
  | 'error'
  | 'offline';

interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
}

interface StepItem {
  label: string;
  completed: boolean;
}

interface EmptyStateProps extends VariantProps<typeof emptyStateVariants> {
  preset?: EmptyStatePreset;
  icon?: React.ComponentType<{
    className?: string;
    weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
  }>;
  /** Custom icon element that replaces the default icon container entirely */
  customIcon?: React.ReactNode;
  title?: string;
  subtitle?: string;
  primaryAction?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /** Step indicators for onboarding flows */
  steps?: StepItem[];
  /** Custom content slot */
  children?: React.ReactNode;
  className?: string;
}

const PRESETS: Record<
  EmptyStatePreset,
  {
    icon: React.ComponentType<{
      className?: string;
      weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
    }>;
    title: string;
    subtitle: string;
    primaryActionLabel?: string;
    secondaryActionLabel?: string;
  }
> = {
  'first-run': {
    icon: RocketLaunch,
    title: 'Welcome to AgentPane',
    subtitle: 'Get started by creating your first project or importing from GitHub',
    primaryActionLabel: 'Create Project',
    secondaryActionLabel: 'Import from GitHub',
  },
  'no-projects': {
    icon: FolderSimple,
    title: 'No Projects',
    subtitle: 'Create a project to start organizing your tasks and agents',
    primaryActionLabel: 'Create Project',
  },
  'no-tasks': {
    icon: ListChecks,
    title: 'No Tasks Yet',
    subtitle: 'Create your first task to start working with your AI agents',
    primaryActionLabel: 'Create Task',
    secondaryActionLabel: 'Import from GitHub Issues',
  },
  'no-agents': {
    icon: Robot,
    title: 'No Agents',
    subtitle: 'Create an agent to automate your development tasks',
    primaryActionLabel: 'Create Agent',
    secondaryActionLabel: 'Learn about agents',
  },
  'empty-session': {
    icon: ChatCircleText,
    title: 'No Session History',
    subtitle: 'Agent activity will appear here once execution begins',
  },
  'no-results': {
    icon: MagnifyingGlass,
    title: 'No Results Found',
    subtitle: 'Try adjusting your search or filter criteria',
    primaryActionLabel: 'Clear Filters',
  },
  error: {
    icon: Warning,
    title: 'Something Went Wrong',
    subtitle: 'We encountered an error loading this content',
    primaryActionLabel: 'Try Again',
    secondaryActionLabel: 'Report Issue',
  },
  offline: {
    icon: WifiSlash,
    title: "You're Offline",
    subtitle: 'Check your internet connection and try again',
    primaryActionLabel: 'Retry',
  },
};

function StepIndicator({ step, index }: { step: StepItem; index: number }) {
  return (
    <li className="flex items-center gap-3 py-2.5 border-b border-border last:border-b-0">
      <span
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-full text-xs flex-shrink-0',
          step.completed
            ? 'bg-success-muted text-success-fg'
            : 'border-2 border-border text-fg-subtle'
        )}
      >
        {step.completed ? <Check className="h-3 w-3" weight="bold" /> : index + 1}
      </span>
      <span className={cn('text-sm', step.completed ? 'text-fg' : 'text-fg-muted')}>
        {step.label}
      </span>
    </li>
  );
}

export function EmptyState({
  preset,
  icon,
  customIcon,
  title,
  subtitle,
  primaryAction,
  secondaryAction,
  steps,
  children,
  size = 'md',
  className,
}: EmptyStateProps): React.JSX.Element {
  const presetConfig = preset ? PRESETS[preset] : undefined;
  const Icon = icon ?? presetConfig?.icon ?? FolderSimple;
  const displayTitle = title ?? presetConfig?.title ?? 'Nothing here';
  const displaySubtitle = subtitle ?? presetConfig?.subtitle ?? '';

  const finalPrimaryAction =
    primaryAction ??
    (presetConfig?.primaryActionLabel
      ? {
          label: presetConfig.primaryActionLabel,
        }
      : undefined);

  const finalSecondaryAction =
    secondaryAction ??
    (presetConfig?.secondaryActionLabel
      ? {
          label: presetConfig.secondaryActionLabel,
        }
      : undefined);

  return (
    <output
      aria-label={displayTitle}
      className={cn(emptyStateVariants({ size }), className)}
      data-testid="empty-state"
    >
      {/* Icon container with 64px icon - or custom icon if provided */}
      {customIcon ? (
        <div data-testid="empty-state-icon">{customIcon}</div>
      ) : (
        <div className={iconContainerVariants({ size })} data-testid="empty-state-icon">
          <Icon className={iconVariants({ size })} weight="light" />
        </div>
      )}

      {/* Title and subtitle */}
      <div className="space-y-1.5">
        <h2 className={titleVariants({ size })} data-testid="empty-state-title">
          {displayTitle}
        </h2>
        {displaySubtitle && (
          <p className={subtitleVariants({ size })} data-testid="empty-state-description">
            {displaySubtitle}
          </p>
        )}
      </div>

      {/* Step indicators for multi-step empty states */}
      {steps && steps.length > 0 && (
        <ul className="w-full max-w-60 text-left list-none">
          {steps.map((step, index) => (
            <StepIndicator key={step.label} step={step} index={index} />
          ))}
        </ul>
      )}

      {/* Custom content slot */}
      {children}

      {/* Action buttons */}
      {(finalPrimaryAction || finalSecondaryAction) && (
        <div className="flex flex-col items-center gap-3 mt-2">
          {finalPrimaryAction && (
            <Button
              variant={finalPrimaryAction.variant ?? 'default'}
              onClick={finalPrimaryAction.onClick}
              className="min-w-32"
              data-testid="empty-state-action"
            >
              {finalPrimaryAction.icon}
              {finalPrimaryAction.label}
            </Button>
          )}

          {finalSecondaryAction &&
            (finalSecondaryAction.href ? (
              <a
                href={finalSecondaryAction.href}
                onClick={finalSecondaryAction.onClick}
                className="text-sm text-accent-fg hover:underline transition-colors"
              >
                {finalSecondaryAction.label}
              </a>
            ) : (
              <button
                type="button"
                onClick={finalSecondaryAction.onClick}
                className="text-sm text-accent-fg hover:underline transition-colors"
              >
                {finalSecondaryAction.label}
              </button>
            ))}
        </div>
      )}
    </output>
  );
}
