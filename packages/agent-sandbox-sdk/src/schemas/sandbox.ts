import { z } from 'zod';

export const podMetadataSchema = z.object({
  labels: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});

export const podTemplateSchema = z.object({
  spec: z.any(), // V1PodSpec - too complex for Zod, use any
  metadata: podMetadataSchema, // NOT optional (no omitempty upstream)
});

export const embeddedObjectMetadataSchema = z.object({
  name: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});

export const persistentVolumeClaimTemplateSchema = z.object({
  metadata: embeddedObjectMetadataSchema,
  spec: z.any(), // V1PersistentVolumeClaimSpec
});

export const shutdownPolicySchema = z.enum(['Delete', 'Retain']);

export const sandboxSpecSchema = z.object({
  podTemplate: podTemplateSchema,
  volumeClaimTemplates: z.array(persistentVolumeClaimTemplateSchema).optional(),
  // Lifecycle fields inlined (not nested)
  shutdownTime: z.string().optional(),
  shutdownPolicy: shutdownPolicySchema.optional(),
  replicas: z.number().int().min(0).max(1).optional(),
});

export const sandboxStatusSchema = z.object({
  serviceFQDN: z.string().optional(),
  service: z.string().optional(),
  conditions: z.array(z.any()).optional(),
  replicas: z.number(), // NOT optional (always present, defaults to 0)
  selector: z.string().optional(),
});

export const sandboxSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('Sandbox'),
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: sandboxSpecSchema,
  status: sandboxStatusSchema.optional(),
});
