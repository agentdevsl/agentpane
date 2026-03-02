import { z } from 'zod';

// --- Budget Config ---

export const budgetConfigSchema = z
  .object({
    maxPerHour: z.number().int().positive().optional(),
    maxPerDay: z.number().int().positive().optional(),
    maxPerWeek: z.number().int().positive().optional(),
    maxPerMonth: z.number().int().positive().optional(),
  })
  .refine(
    (budget) => {
      const { maxPerHour, maxPerDay, maxPerWeek, maxPerMonth } = budget;
      if (maxPerHour !== undefined && maxPerDay !== undefined && maxPerDay < maxPerHour)
        return false;
      if (maxPerDay !== undefined && maxPerWeek !== undefined && maxPerWeek < maxPerDay)
        return false;
      if (maxPerWeek !== undefined && maxPerMonth !== undefined && maxPerMonth < maxPerWeek)
        return false;
      return true;
    },
    { message: 'Budget limits must be non-decreasing: hour <= day <= week <= month' }
  );

// --- Cron Expression Validation ---

const cronExpressionSchema = z
  .string()
  .regex(
    /^(\*|[0-9,\-/]+)\s+(\*|[0-9,\-/]+)\s+(\*|[0-9,\-/]+)\s+(\*|[0-9,\-/]+)\s+(\*|[0-9,\-/]+)$/,
    'Must be a valid 5-field cron expression (minute hour day month weekday)'
  );

// --- Timezone Validation ---

const timezoneSchema = z
  .string()
  .min(1)
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA timezone (e.g., "America/New_York", "UTC")' }
  );

// --- Cron Event Source Config ---

const cronConfigBaseSchema = z.discriminatedUnion('scheduleType', [
  z.object({
    scheduleType: z.literal('interval'),
    interval: z
      .number()
      .int()
      .min(60, 'Minimum interval is 60 seconds')
      .max(2592000, 'Maximum interval is 2592000 seconds (30 days)'),
    timezone: timezoneSchema,
    budget: budgetConfigSchema,
  }),
  z.object({
    scheduleType: z.literal('cron'),
    cronExpression: cronExpressionSchema,
    timezone: timezoneSchema,
    budget: budgetConfigSchema,
  }),
]);

// --- Create Cron Event Source ---

export const createCronEventSourceSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
  config: cronConfigBaseSchema,
});

// --- Update Cron Event Source ---

export const updateCronEventSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isEnabled: z.boolean().optional(),
  config: z
    .object({
      scheduleType: z.enum(['interval', 'cron']).optional(),
      interval: z
        .number()
        .int()
        .min(60, 'Minimum interval is 60 seconds')
        .max(2592000, 'Maximum interval is 2592000 seconds (30 days)')
        .optional(),
      cronExpression: cronExpressionSchema.optional(),
      timezone: timezoneSchema.optional(),
      budget: budgetConfigSchema.optional(),
    })
    .optional(),
});

// --- Manual Trigger Schema ---

export const manualTriggerSchema = z.object({
  promptOverride: z.string().max(10000).optional(),
});

// --- List Executions Schema ---

export const listExecutionsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  status: z.enum(['executed', 'skipped_budget', 'skipped_disabled', 'error']).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

// Type exports
export type CreateCronEventSourceInput = z.infer<typeof createCronEventSourceSchema>;
export type UpdateCronEventSourceInput = z.infer<typeof updateCronEventSourceSchema>;
export type CronBudgetConfig = z.infer<typeof budgetConfigSchema>;
