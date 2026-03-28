/**
 * Schemas for client-side and shared API validation.
 *
 * Shared enum schemas (taskColumnSchema, agentTypeSchema) are imported from the
 * canonical source in `src/server/validation.ts` to avoid duplication and drift.
 *
 * This file extends those canonical schemas with client-specific schemas
 * (e.g., codespace creation, sandbox configs, workflows, agent status)
 * that are not used in server route handlers.
 */
import { isCuid } from '@paralleldrive/cuid2';
import { z } from 'zod';
import { workflowEdgeSchema, workflowNodeSchema } from '@/lib/workflow-dsl/types.js';
import { agentTypeSchema, taskColumnSchema } from '@/server/validation.js';
import { codespaceConfigSchema } from '../config/schemas.js';

const cuidSchema = z.string().refine(isCuid, { message: 'Invalid ID format' });
/** Agent status enum -- client-only, not used in server route validation */
const agentStatusSchema = z.enum(['idle', 'starting', 'running', 'paused', 'error', 'completed']);

export const listProjectsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
  description: z.string().max(500).optional(),
  config: codespaceConfigSchema.optional(),
  maxConcurrentAgents: z.number().min(1).max(10).optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
  sandboxConfigId: cuidSchema.optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  config: codespaceConfigSchema.partial().optional(),
  maxConcurrentAgents: z.number().min(1).max(10).optional(),
});

export const listTasksSchema = z.object({
  codespaceId: cuidSchema,
  column: taskColumnSchema.optional(),
  agentId: cuidSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export const createTaskSchema = z.object({
  codespaceId: cuidSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  labels: z.array(z.string()).max(10).optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  labels: z.array(z.string()).max(10).optional(),
  /** Model override for this task (short ID like 'claude-opus-4' or null to clear) */
  modelOverride: z.string().nullable().optional(),
});

export const moveTaskSchema = z.object({
  column: taskColumnSchema,
  position: z.coerce.number().min(0).optional(),
});

export const approveTaskSchema = z.object({
  approvedBy: z.string().optional(),
  createMergeCommit: z.boolean().optional(),
});

export const rejectTaskSchema = z.object({
  reason: z.string().min(1).max(1000),
});

export const listAgentsSchema = z.object({
  codespaceId: cuidSchema,
  status: agentStatusSchema.optional(),
  type: agentTypeSchema.optional(),
});

const agentConfigSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().min(1).max(500).optional(),
  model: z.string().optional(),
  systemPrompt: z.string().max(10000).optional(),
  temperature: z.number().min(0).max(1).optional(),
});

export const createAgentSchema = z.object({
  codespaceId: cuidSchema,
  name: z.string().min(1).max(100),
  type: agentTypeSchema.default('task'),
  config: agentConfigSchema.optional(),
});

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  config: agentConfigSchema.partial().optional(),
});

export const startAgentSchema = z.object({
  taskId: cuidSchema.optional(),
});

export const createSessionSchema = z.object({
  codespaceId: cuidSchema,
  taskId: cuidSchema.optional(),
  agentId: cuidSchema.optional(),
  title: z.string().max(200).optional(),
});

export const updatePresenceSchema = z.object({
  userId: z.string().min(1),
  cursor: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  activeFile: z.string().optional(),
});

// Worktree schemas
export const listWorktreesSchema = z.object({
  codespaceId: cuidSchema,
});

export const createWorktreeSchema = z.object({
  codespaceId: cuidSchema,
  taskId: cuidSchema,
  baseBranch: z.string().optional(),
});

export const commitWorktreeSchema = z.object({
  message: z.string().min(1).max(500),
});

export const mergeWorktreeSchema = z.object({
  targetBranch: z.string().optional(),
});

export const pruneWorktreesSchema = z.object({
  codespaceId: cuidSchema,
});

// Agent lifecycle schemas
export const pauseAgentSchema = z.object({});

export const resumeAgentSchema = z.object({
  feedback: z.string().max(5000).optional(),
});

// GitHub webhook schema
export const githubWebhookSchema = z.object({
  action: z.string(),
  installation: z
    .object({
      id: z.number(),
      account: z.object({
        login: z.string(),
        type: z.string(),
      }),
    })
    .optional(),
  repository: z
    .object({
      owner: z.object({ login: z.string() }),
      name: z.string(),
    })
    .optional(),
});

// Template schemas
const templateScopeSchema = z.enum(['org', 'codespace']);

export const listTemplatesSchema = z.object({
  scope: templateScopeSchema.optional(),
  codespaceId: cuidSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

// GitHub URL validation - accepts full URLs or owner/repo format
const githubUrlSchema = z.string().refine(
  (val) => {
    // Accept owner/repo format
    if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(val)) return true;
    // Accept full GitHub URLs
    if (/github\.com[/:][a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/.test(val)) return true;
    return false;
  },
  { message: 'Must be a GitHub repository URL or owner/repo format' }
);

/** Sync interval validation: must be >= 5 minutes or null (disabled) */
const syncIntervalSchema = z
  .number()
  .int()
  .min(5, 'Sync interval must be at least 5 minutes')
  .nullable()
  .optional();

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  scope: templateScopeSchema,
  githubUrl: githubUrlSchema,
  branch: z.string().max(100).optional(),
  configPath: z.string().max(500).optional(),
  /** Codespace IDs to associate with this template (for codespace-scoped templates) */
  codespaceIds: z.array(cuidSchema).optional(),
  /** Auto-sync interval in minutes (null = disabled, minimum 5 minutes) */
  syncIntervalMinutes: syncIntervalSchema,
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  branch: z.string().max(100).optional(),
  configPath: z.string().max(500).optional(),
  /** Update the codespace associations (replaces existing) */
  codespaceIds: z.array(cuidSchema).optional(),
  /** Auto-sync interval in minutes (null = disabled, minimum 5 minutes) */
  syncIntervalMinutes: syncIntervalSchema,
});

// Sandbox Config schemas
export const sandboxTypeSchema = z.enum(['docker', 'devcontainer', 'kubernetes']);

export const listSandboxConfigsSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});

/** Kubernetes namespace validation: RFC 1123 DNS label (lowercase alphanumeric, dashes, max 63 chars) */
const k8sNamespaceSchema = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, {
    message: 'Namespace must be a valid DNS label (lowercase letters, numbers, dashes)',
  })
  .optional();

export const createSandboxConfigSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: sandboxTypeSchema.optional().default('docker'),
  isDefault: z.boolean().optional().default(false),
  baseImage: z.string().min(1).max(200).optional().default('node:22-slim'),
  memoryMb: z.coerce.number().min(512).max(32768).optional().default(4096),
  cpuCores: z.coerce.number().min(0.5).max(16).optional().default(2.0),
  maxProcesses: z.coerce.number().min(32).max(4096).optional().default(256),
  timeoutMinutes: z.coerce.number().min(1).max(1440).optional().default(60),
  /** Volume mount path from local host for docker sandboxes */
  volumeMountPath: z.string().max(500).optional(),

  // Kubernetes-specific configuration
  /** Path to kubeconfig file (e.g., ~/.kube/config) */
  kubeConfigPath: z.string().max(500).optional(),
  /** Kubernetes context name to use */
  kubeContext: z.string().max(256).optional(),
  /** Kubernetes namespace for sandbox pods */
  kubeNamespace: k8sNamespaceSchema.default('agentpane-sandboxes'),
  /** Enable network policies for K8s sandboxes */
  networkPolicyEnabled: z.boolean().optional().default(true),
  /** Allowed egress hosts for network policies */
  allowedEgressHosts: z.array(z.string().max(256)).max(50).optional(),
});

export const updateSandboxConfigSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  type: sandboxTypeSchema.optional(),
  isDefault: z.boolean().optional(),
  baseImage: z.string().min(1).max(200).optional(),
  memoryMb: z.coerce.number().min(512).max(32768).optional(),
  cpuCores: z.coerce.number().min(0.5).max(16).optional(),
  maxProcesses: z.coerce.number().min(32).max(4096).optional(),
  timeoutMinutes: z.coerce.number().min(1).max(1440).optional(),
  /** Volume mount path from local host for docker sandboxes */
  volumeMountPath: z.string().max(500).optional(),

  // Kubernetes-specific configuration
  /** Path to kubeconfig file (e.g., ~/.kube/config) */
  kubeConfigPath: z.string().max(500).optional(),
  /** Kubernetes context name to use */
  kubeContext: z.string().max(256).optional(),
  /** Kubernetes namespace for sandbox pods */
  kubeNamespace: k8sNamespaceSchema,
  /** Enable network policies for K8s sandboxes */
  networkPolicyEnabled: z.boolean().optional(),
  /** Allowed egress hosts for network policies */
  allowedEgressHosts: z.array(z.string().max(256)).max(50).optional(),
});

// Kubernetes API schemas
export const k8sStatusQuerySchema = z.object({
  /** Optional kubeconfig path to check status for */
  kubeconfigPath: z.string().max(500).optional(),
  /** Optional context to use */
  context: z.string().max(256).optional(),
});

export const k8sContextsQuerySchema = z.object({
  /** Optional kubeconfig path to list contexts from */
  kubeconfigPath: z.string().max(500).optional(),
});

export const k8sNamespacesQuerySchema = z.object({
  /** Optional kubeconfig path */
  kubeconfigPath: z.string().max(500).optional(),
  /** Optional context to use */
  context: z.string().max(256).optional(),
  /** Pagination limit */
  limit: z.coerce.number().min(1).max(100).default(50),
});

// Session history schemas
const sessionStatusSchema = z.enum([
  'idle',
  'initializing',
  'active',
  'paused',
  'closing',
  'closed',
  'error',
]);

export const listSessionsSchema = z.object({
  /** Filter by session statuses (comma-separated or multiple params) */
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((val) => {
      if (!val) return undefined;
      const statuses = Array.isArray(val) ? val : val.split(',');
      return statuses.filter((s) => sessionStatusSchema.safeParse(s).success);
    }),
  /** Filter by agent ID */
  agentId: cuidSchema.optional(),
  /** Filter by task ID */
  taskId: cuidSchema.optional(),
  /** Filter sessions created after this date (ISO string) */
  dateFrom: z.string().optional(),
  /** Filter sessions created before this date (ISO string) */
  dateTo: z.string().optional(),
  /** Search in session title */
  search: z.string().optional(),
  /** Pagination limit */
  limit: z.coerce.number().min(1).max(100).default(50),
  /** Pagination offset */
  offset: z.coerce.number().min(0).default(0),
});

export const sessionEventsSchema = z.object({
  /** Number of events to return */
  limit: z.coerce.number().min(1).max(1000).default(50),
  /** Number of events to skip */
  offset: z.coerce.number().min(0).default(0),
});

export const sessionExportSchema = z.object({
  /** Export format */
  format: z.enum(['json', 'markdown', 'csv']),
});

// Workflow schemas
// Note: workflowNodeSchema and workflowEdgeSchema imported from @/lib/workflow-dsl/types.js
const workflowStatusSchema = z.enum(['draft', 'published', 'archived']);

const workflowViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
});

export const listWorkflowsSchema = z.object({
  /** Pagination limit */
  limit: z.coerce.number().min(1).max(100).default(50),
  /** Pagination offset */
  offset: z.coerce.number().min(0).default(0),
  /** Filter by status (draft, published, archived) */
  status: workflowStatusSchema.optional(),
  /** Search in name and description */
  search: z.string().optional(),
});

export const createWorkflowSchema = z.object({
  /** Workflow name (required) */
  name: z.string().min(1).max(200),
  /** Workflow description */
  description: z.string().max(2000).optional(),
  /** Workflow nodes */
  nodes: z.array(workflowNodeSchema).optional(),
  /** Workflow edges */
  edges: z.array(workflowEdgeSchema).optional(),
  /** Canvas viewport state */
  viewport: workflowViewportSchema.optional(),
  /** Workflow status */
  status: workflowStatusSchema.optional(),
  /** Tags for categorization */
  tags: z.array(z.string().max(50)).max(20).optional(),
  /** Source template ID (if created from a template) */
  sourceTemplateId: cuidSchema.optional(),
  /** Source template name */
  sourceTemplateName: z.string().max(200).optional(),
  /** Thumbnail image URL or data */
  thumbnail: z.string().max(5000).optional(),
  /** Whether this workflow was AI-generated */
  aiGenerated: z.boolean().optional(),
  /** AI model used for generation */
  aiModel: z.string().max(100).optional(),
  /** AI confidence score (0-100) */
  aiConfidence: z.number().min(0).max(100).optional(),
});

export const updateWorkflowSchema = z.object({
  /** Workflow name */
  name: z.string().min(1).max(200).optional(),
  /** Workflow description */
  description: z.string().max(2000).optional(),
  /** Workflow nodes */
  nodes: z.array(workflowNodeSchema).optional(),
  /** Workflow edges */
  edges: z.array(workflowEdgeSchema).optional(),
  /** Canvas viewport state */
  viewport: workflowViewportSchema.optional(),
  /** Workflow status */
  status: workflowStatusSchema.optional(),
  /** Tags for categorization */
  tags: z.array(z.string().max(50)).max(20).optional(),
  /** Source template ID */
  sourceTemplateId: cuidSchema.nullable().optional(),
  /** Source template name */
  sourceTemplateName: z.string().max(200).nullable().optional(),
  /** Thumbnail image URL or data */
  thumbnail: z.string().max(5000).nullable().optional(),
  /** Whether this workflow was AI-generated */
  aiGenerated: z.boolean().optional(),
  /** AI model used for generation */
  aiModel: z.string().max(100).nullable().optional(),
  /** AI confidence score (0-100) */
  aiConfidence: z.number().min(0).max(100).nullable().optional(),
});

// Settings schemas
export const getSettingsSchema = z.object({
  /** Comma-separated list of setting keys to retrieve (optional, returns all if not specified) */
  keys: z.string().optional(),
});

export const updateSettingsSchema = z.object({
  /** Map of setting keys to values */
  settings: z.record(z.string(), z.unknown()),
});
