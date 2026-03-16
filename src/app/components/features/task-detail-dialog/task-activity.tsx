import { Brain, ChatText, Check, Clock, File, Play, Terminal, X } from '@phosphor-icons/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import type { Task } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import { formatRelativeTime } from '@/lib/utils/format-time';
import type { ActivityEntry } from './index';
import { useTaskActivity } from './use-task-activity';

const BOLD_ACTIVITY_TYPES = new Set<ActivityEntry['type']>([
  'status_change',
  'approval',
  'rejection',
]);

interface TaskActivityProps {
  task: Task;
  activeTab: 'timeline' | 'comments' | 'history';
  onTabChange: (tab: 'timeline' | 'comments' | 'history') => void;
}

function getActivityIcon(type: ActivityEntry['type'], message?: string): React.ElementType {
  switch (type) {
    case 'status_change':
      return message?.includes('planning') ? Brain : Play;
    case 'tool_call':
      return message?.startsWith('Running') ? Terminal : File;
    case 'comment':
      return ChatText;
    case 'rejection':
      return X;
    case 'approval':
      return Check;
    default:
      return Clock;
  }
}

function getActivityColor(type: ActivityEntry['type']): string {
  switch (type) {
    case 'status_change':
      return 'text-accent';
    case 'tool_call':
      return 'text-fg-muted';
    case 'comment':
      return 'text-fg';
    case 'rejection':
      return 'text-danger';
    case 'approval':
      return 'text-success';
    default:
      return 'text-fg-muted';
  }
}

interface ActivityItemProps {
  activity: ActivityEntry;
  isLast: boolean;
}

function ActivityItem({ activity, isLast }: ActivityItemProps): React.JSX.Element {
  const Icon = getActivityIcon(activity.type, activity.message);
  const color = getActivityColor(activity.type);
  const isBold = BOLD_ACTIVITY_TYPES.has(activity.type);

  return (
    <div className="flex gap-3">
      {/* Timeline line and dot */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full',
            'bg-surface-muted border border-border'
          )}
        >
          <Icon className={cn('h-3 w-3', color)} />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border" />}
      </div>

      {/* Content */}
      <div className={cn('flex-1 pb-4', isLast && 'pb-0')}>
        <p className={cn('text-sm text-fg', isBold && 'font-medium')}>{activity.message}</p>
        <span className="text-xs text-fg-subtle">{formatRelativeTime(activity.timestamp)}</span>
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <Clock className="h-8 w-8 text-fg-subtle mb-2" />
      <p className="text-sm text-fg-muted">{message}</p>
    </div>
  );
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3 p-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3 animate-pulse">
          <div className="h-6 w-6 rounded-full bg-surface-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-3/4 rounded bg-surface-muted" />
            <div className="h-2.5 w-1/4 rounded bg-surface-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityList({ activities }: { activities: ActivityEntry[] }): React.JSX.Element {
  return (
    <div className="space-y-0">
      {activities.map((activity, index) => (
        <ActivityItem
          key={activity.id}
          activity={activity}
          isLast={index === activities.length - 1}
        />
      ))}
    </div>
  );
}

export function TaskActivity({
  task,
  activeTab,
  onTabChange,
}: TaskActivityProps): React.JSX.Element {
  const { activities, isLoading, error } = useTaskActivity(task);

  // Filter activities by type for each tab
  const timelineActivities = activities;
  const commentActivities = activities.filter((a) => a.type === 'comment');
  const historyActivities = activities.filter((a) => BOLD_ACTIVITY_TYPES.has(a.type));

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Activity</h3>

      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline">
          <div className="rounded-md border border-border bg-surface-subtle p-4">
            {isLoading ? (
              <LoadingSkeleton />
            ) : error ? (
              <EmptyState message={error} />
            ) : timelineActivities.length > 0 ? (
              <ActivityList activities={timelineActivities} />
            ) : (
              <EmptyState message="No activity yet" />
            )}
          </div>
        </TabsContent>

        <TabsContent value="comments">
          <div className="rounded-md border border-border bg-surface-subtle p-4">
            {isLoading ? (
              <LoadingSkeleton />
            ) : error ? (
              <EmptyState message={error} />
            ) : commentActivities.length > 0 ? (
              <ActivityList activities={commentActivities} />
            ) : (
              <EmptyState message="No comments yet" />
            )}
          </div>
        </TabsContent>

        <TabsContent value="history">
          <div className="rounded-md border border-border bg-surface-subtle p-4">
            {isLoading ? (
              <LoadingSkeleton />
            ) : error ? (
              <EmptyState message={error} />
            ) : historyActivities.length > 0 ? (
              <ActivityList activities={historyActivities} />
            ) : (
              <EmptyState message="No state changes yet" />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
