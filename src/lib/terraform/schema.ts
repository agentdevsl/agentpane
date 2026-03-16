import { z } from 'zod';

// Note: ComposeMessage and ModuleMatch TS interfaces live in ./types.ts.
// The Zod schemas here are used for runtime request validation only.

export const composeMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

export const composeRequestSchema = z.object({
  sessionId: z.string().optional(),
  messages: z.array(composeMessageSchema).min(1),
  registryId: z.string().optional(),
  composeMode: z.enum(['terraform', 'stacks']).optional().default('terraform'),
});

export const createRegistrySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  orgName: z.string().min(1, 'Organization name is required'),
  apiToken: z.string().min(1, 'API token is required'),
  syncIntervalMinutes: z.number().int().min(5).optional(),
});

export const updateRegistrySchema = z.object({
  name: z.string().min(1).optional(),
  orgName: z.string().min(1).optional(),
  apiToken: z.string().min(1).optional(),
  syncIntervalMinutes: z.number().int().min(5).nullable().optional(),
});

export const moduleMatchSchema = z.object({
  moduleId: z.string(),
  name: z.string(),
  provider: z.string(),
  version: z.string(),
  source: z.string(),
  confidence: z.number().min(0).max(1),
  matchReason: z.string(),
});

export type ComposeRequest = z.infer<typeof composeRequestSchema>;
export type CreateRegistryInput = z.infer<typeof createRegistrySchema>;
export type UpdateRegistryInput = z.infer<typeof updateRegistrySchema>;
export type ModuleMatchSchema = z.infer<typeof moduleMatchSchema>;
