import { z } from 'zod';
import { sandboxTemplateRefSchema } from './claim.js';

export const sandboxWarmPoolSpecSchema = z.object({
  replicas: z.number().int().min(0), // was desiredReady
  sandboxTemplateRef: sandboxTemplateRefSchema, // was templateRef
});

export const sandboxWarmPoolStatusSchema = z.object({
  replicas: z.number().optional(),
  readyReplicas: z.number().optional(),
});

export const sandboxWarmPoolSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('SandboxWarmPool'),
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: sandboxWarmPoolSpecSchema,
  status: sandboxWarmPoolStatusSchema.optional(),
});
