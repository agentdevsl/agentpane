import { describe, expect, it } from 'vitest';
import {
  budgetConfigSchema,
  createCronEventSourceSchema,
  listExecutionsSchema,
  manualTriggerSchema,
  updateCronEventSourceSchema,
} from '@/lib/validation/cron-event-sources';

// ---------------------------------------------------------------------------
// Budget config
// ---------------------------------------------------------------------------

describe('budgetConfigSchema', () => {
  it('accepts valid budget with all fields', () => {
    const result = budgetConfigSchema.safeParse({
      maxPerHour: 1,
      maxPerDay: 10,
      maxPerWeek: 50,
      maxPerMonth: 200,
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty budget (all optional)', () => {
    const result = budgetConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects when maxPerDay < maxPerHour', () => {
    const result = budgetConfigSchema.safeParse({
      maxPerHour: 10,
      maxPerDay: 5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects when maxPerWeek < maxPerDay', () => {
    const result = budgetConfigSchema.safeParse({
      maxPerDay: 20,
      maxPerWeek: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects when maxPerMonth < maxPerWeek', () => {
    const result = budgetConfigSchema.safeParse({
      maxPerWeek: 100,
      maxPerMonth: 50,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer values', () => {
    const result = budgetConfigSchema.safeParse({ maxPerHour: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects zero values', () => {
    const result = budgetConfigSchema.safeParse({ maxPerHour: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative values', () => {
    const result = budgetConfigSchema.safeParse({ maxPerHour: -1 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cron expression (via createCronEventSourceSchema)
// ---------------------------------------------------------------------------

describe('Cron expression validation', () => {
  it('accepts a standard cron expression', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'My Cron',
      config: {
        scheduleType: 'cron',
        cronExpression: '0 9 * * 1-5',
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts every-minute cron expression', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Every minute',
      config: {
        scheduleType: 'cron',
        cronExpression: '* * * * *',
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects 6-field cron expression', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Bad cron',
      config: {
        scheduleType: 'cron',
        cronExpression: '0 0 9 * * 1-5',
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty cron expression', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Empty cron',
      config: {
        scheduleType: 'cron',
        cronExpression: '',
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timezone validation
// ---------------------------------------------------------------------------

describe('Timezone validation', () => {
  it('accepts UTC', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'TZ test',
      config: {
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts America/New_York', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'TZ test',
      config: {
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        timezone: 'America/New_York',
        budget: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid timezone', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'TZ test',
      config: {
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        timezone: 'Invalid/Timezone',
        budget: {},
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interval schedule type
// ---------------------------------------------------------------------------

describe('Interval schedule type', () => {
  it('accepts valid interval', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Interval',
      config: {
        scheduleType: 'interval',
        interval: 300,
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects interval below 60 seconds', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Too fast',
      config: {
        scheduleType: 'interval',
        interval: 30,
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects interval above 30 days', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Too slow',
      config: {
        scheduleType: 'interval',
        interval: 2592001,
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

describe('Slug validation', () => {
  it('accepts a valid slug', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Slug test',
      slug: 'my-cron-job',
      config: {
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects slug with uppercase characters', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Slug test',
      slug: 'My-Cron',
      config: {
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects slug starting with hyphen', () => {
    const result = createCronEventSourceSchema.safeParse({
      teamId: 'team-1',
      name: 'Slug test',
      slug: '-bad-slug',
      config: {
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
        budget: {},
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Update schema
// ---------------------------------------------------------------------------

describe('updateCronEventSourceSchema', () => {
  it('accepts partial update with name only', () => {
    const result = updateCronEventSourceSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('accepts partial update with isEnabled', () => {
    const result = updateCronEventSourceSchema.safeParse({ isEnabled: false });
    expect(result.success).toBe(true);
  });

  it('accepts empty update', () => {
    const result = updateCronEventSourceSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Manual trigger schema
// ---------------------------------------------------------------------------

describe('manualTriggerSchema', () => {
  it('accepts empty object', () => {
    const result = manualTriggerSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a prompt override', () => {
    const result = manualTriggerSchema.safeParse({ promptOverride: 'Run now please' });
    expect(result.success).toBe(true);
  });

  it('rejects prompt override exceeding 10000 chars', () => {
    const result = manualTriggerSchema.safeParse({ promptOverride: 'x'.repeat(10001) });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// List executions schema
// ---------------------------------------------------------------------------

describe('listExecutionsSchema', () => {
  it('accepts default values', () => {
    const result = listExecutionsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it('accepts valid status filter', () => {
    const result = listExecutionsSchema.safeParse({ status: 'executed' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = listExecutionsSchema.safeParse({ status: 'invalid_status' });
    expect(result.success).toBe(false);
  });

  it('rejects limit above 100', () => {
    const result = listExecutionsSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects limit below 1', () => {
    const result = listExecutionsSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });
});
