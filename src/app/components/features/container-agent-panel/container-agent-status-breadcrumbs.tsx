import { CaretRight, Check, CircleNotch } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import type {
  ContainerAgentStage,
  ContainerAgentStatusEntry,
} from '@/app/hooks/use-container-agent';

interface ContainerAgentStatusBreadcrumbsProps {
  currentStage?: ContainerAgentStage;
  statusMessage?: string;
  statusHistory: ContainerAgentStatusEntry[];
}

const STAGES: ContainerAgentStage[] = [
  'initializing',
  'validating',
  'credentials',
  'creating_sandbox',
  'executing',
  'running',
];

const stageLabels: Record<ContainerAgentStage, string> = {
  initializing: 'Initializing',
  validating: 'Validating',
  credentials: 'Credentials',
  creating_sandbox: 'Creating Sandbox',
  executing: 'Executing',
  running: 'Running',
};

const stageIconVariants = cva(
  'flex h-5 w-5 items-center justify-center rounded-full text-xs font-medium transition-all',
  {
    variants: {
      state: {
        pending: 'bg-surface-subtle text-fg-muted',
        active: 'bg-accent text-white animate-pulse',
        complete: 'bg-success text-white',
      },
    },
    defaultVariants: {
      state: 'pending',
    },
  }
);

const stageLabelVariants = cva('text-xs transition-colors', {
  variants: {
    state: {
      pending: 'text-fg-muted',
      active: 'text-accent font-medium',
      complete: 'text-fg',
    },
  },
  defaultVariants: {
    state: 'pending',
  },
});

function getStageState(
  stage: ContainerAgentStage,
  currentStage: ContainerAgentStage | undefined,
  statusHistory: ContainerAgentStatusEntry[]
): 'pending' | 'active' | 'complete' {
  if (stage === currentStage) return 'active';

  // Check if this stage has been completed (exists in history and a later stage is current)
  const stageIndex = STAGES.indexOf(stage);
  const currentIndex = currentStage ? STAGES.indexOf(currentStage) : -1;

  if (stageIndex < currentIndex) return 'complete';
  if (statusHistory.some((entry) => entry.stage === stage) && stageIndex < currentIndex) {
    return 'complete';
  }

  return 'pending';
}

/**
 * Container Agent Status Breadcrumbs - Shows startup progress stages
 */
export function ContainerAgentStatusBreadcrumbs({
  currentStage,
  statusMessage,
  statusHistory,
}: ContainerAgentStatusBreadcrumbsProps): React.JSX.Element {
  return (
    <div
      className="border-b border-border bg-surface-subtle/50 px-4 py-2"
      data-testid="container-agent-breadcrumbs"
    >
      {/* Stage progress */}
      <div className="flex items-center gap-1">
        {STAGES.map((stage, index) => {
          const state = getStageState(stage, currentStage, statusHistory);
          const isLast = index === STAGES.length - 1;

          return (
            <div key={stage} className="flex items-center">
              <div className="flex items-center gap-1.5">
                <div className={stageIconVariants({ state })}>
                  {state === 'complete' ? (
                    <Check className="h-3 w-3" weight="bold" />
                  ) : state === 'active' ? (
                    <CircleNotch className="h-3 w-3 animate-spin" />
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <span className={stageLabelVariants({ state })}>{stageLabels[stage]}</span>
              </div>

              {!isLast ? <CaretRight className="mx-1.5 h-3 w-3 text-fg-muted/50" /> : null}
            </div>
          );
        })}
      </div>

      {/* Current status message */}
      {statusMessage ? <p className="mt-1.5 text-xs text-fg-muted">{statusMessage}</p> : null}
    </div>
  );
}
