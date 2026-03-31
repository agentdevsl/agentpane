import { z } from 'zod';
import { shutdownPolicySchema } from './sandbox.js';

export const sandboxTemplateRefSchema = z.object({
  name: z.string(),
  // No namespace - v0.2.1 SandboxTemplateRef is name-only
});

export const lifecycleSchema = z.object({
  shutdownTime: z.string().optional(),
  shutdownPolicy: shutdownPolicySchema.optional(),
});

// CRITICAL: Capital-N "Name" matches upstream json:"Name,omitempty"
export const claimSandboxStatusSchema = z.object({
  Name: z.string().optional(),
});

export const sandboxClaimSpecSchema = z.object({
  sandboxTemplateRef: sandboxTemplateRefSchema,
  lifecycle: lifecycleSchema.optional(),
});

export const sandboxClaimStatusSchema = z.object({
  conditions: z.array(z.any()).optional(),
  sandbox: claimSandboxStatusSchema.optional(),
});

export const sandboxClaimSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('SandboxClaim'),
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: sandboxClaimSpecSchema,
  status: sandboxClaimStatusSchema.optional(),
});
