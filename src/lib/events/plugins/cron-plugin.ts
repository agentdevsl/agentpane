import { createId } from '@paralleldrive/cuid2';
import type { CronEventSourceConfig } from '../../../db/schema/shared/cron-config.js';
import type { AppError } from '../../errors/base.js';
import { EventErrors } from '../../errors/event-errors.js';
import type { Result } from '../../utils/result.js';
import { err, ok } from '../../utils/result.js';
import type {
  EventSourcePlugin,
  EventTypeDefinition,
  NormalizedEvent,
  SubscriptionFilter,
  TemplateVariable,
} from '../plugin-interface.js';

/**
 * Context passed from the SchedulerService when invoking the cron plugin.
 */
export interface CronTickContext {
  sourceName: string;
  config: CronEventSourceConfig;
  executionCount: number;
  trigger: 'tick' | 'manual';
}

export class CronEventSourcePlugin implements EventSourcePlugin {
  readonly type = 'cron';

  async verifySignature(
    _payload: string,
    _signature: string | null,
    _secret: string
  ): Promise<Result<boolean, AppError>> {
    return ok(true);
  }

  parseEvent(_headers: Headers, rawBody: string): Result<NormalizedEvent, AppError> {
    let context: CronTickContext;
    try {
      context = JSON.parse(rawBody) as CronTickContext;
    } catch {
      return err(EventErrors.PARSE_FAILED('Invalid JSON in cron tick context'));
    }
    const { sourceName, config, executionCount, trigger } = context;
    const timestamp = new Date().toISOString();
    const isManual = trigger === 'manual';

    const normalized: NormalizedEvent = {
      type: isManual ? 'schedule.manual_trigger' : 'schedule.tick',
      action: isManual ? 'manual' : 'tick',
      deliveryId: createId(),
      source: {
        repo: undefined,
        branch: undefined,
        labels: [],
        author: 'system',
      },
      data: {
        title: `Scheduled execution: ${sourceName}`,
        body: isManual
          ? `Manual trigger of "${sourceName}" at ${timestamp}`
          : `Scheduled task triggered at ${timestamp}`,
        url: undefined,
        number: undefined,
        scheduleName: sourceName,
        scheduleType: config.scheduleType,
        cronExpression: config.cronExpression,
        interval: config.interval,
        executionCount,
        lastRunAt: config.lastRunAt,
      },
      raw: {
        schedule: { ...config },
        trigger,
        timestamp,
        executionCount,
        sourceName,
      },
    };

    return ok(normalized);
  }

  getEventTypes(): EventTypeDefinition[] {
    return [
      {
        type: 'schedule.tick',
        label: 'Scheduled Tick',
        actions: ['tick'],
      },
      {
        type: 'schedule.manual_trigger',
        label: 'Manual Trigger',
        actions: ['manual'],
      },
    ];
  }

  getTemplateVariables(_eventType: string): TemplateVariable[] {
    return [
      { name: 'schedule.name', description: 'Name of the schedule', example: 'Daily code review' },
      {
        name: 'schedule.lastRunAt',
        description: 'ISO-8601 timestamp of previous execution',
        example: '2026-03-01T09:00:00Z',
      },
      {
        name: 'schedule.executionCount',
        description: 'Total executions for this schedule',
        example: '42',
      },
      {
        name: 'schedule.cronExpression',
        description: 'Cron expression (if cron type)',
        example: '0 9 * * 1-5',
      },
      {
        name: 'schedule.interval',
        description: 'Interval in seconds (if interval type)',
        example: '3600',
      },
      {
        name: 'schedule.scheduleType',
        description: 'Schedule type: interval or cron',
        example: 'cron',
      },
      { name: 'schedule.timezone', description: 'IANA timezone', example: 'America/New_York' },
      {
        name: 'timestamp',
        description: 'ISO-8601 timestamp of current execution',
        example: '2026-03-02T09:00:00Z',
      },
      { name: 'trigger', description: 'How execution was triggered', example: 'tick' },
      { name: 'event.type', description: 'Event type', example: 'schedule.tick' },
      { name: 'event.action', description: 'Event action', example: 'tick' },
    ];
  }

  matchesFilter(event: NormalizedEvent, filter: SubscriptionFilter): boolean {
    if (filter.field === 'action') {
      switch (filter.operator) {
        case 'equals':
          return event.action === filter.value;
        case 'not_equals':
          return event.action !== filter.value;
        case 'contains':
          return event.action?.includes(filter.value) ?? false;
        case 'matches': {
          if (filter.value.length > 200) return false;
          try {
            return new RegExp(filter.value).test(event.action ?? '');
          } catch {
            return false;
          }
        }
        default:
          return true;
      }
    }
    // All other filter fields always match for cron events
    return true;
  }
}
