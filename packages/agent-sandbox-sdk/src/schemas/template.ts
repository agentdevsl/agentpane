import { z } from 'zod';
import { podTemplateSchema } from './sandbox.js';

export const networkPolicySpecSchema = z.object({
  ingress: z.array(z.any()).optional(), // V1NetworkPolicyIngressRule[]
  egress: z.array(z.any()).optional(), // V1NetworkPolicyEgressRule[]
});

export const networkPolicyManagementSchema = z.enum(['Managed', 'Unmanaged']);

export const sandboxTemplateSpecSchema = z.object({
  podTemplate: podTemplateSchema,
  networkPolicy: networkPolicySpecSchema.optional(),
  networkPolicyManagement: networkPolicyManagementSchema.optional(),
});

export const sandboxTemplateStatusSchema = z.object({});

export const sandboxTemplateSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('SandboxTemplate'),
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: sandboxTemplateSpecSchema,
  status: sandboxTemplateStatusSchema.optional(),
});
