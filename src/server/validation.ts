/**
 * Shared Zod validation schemas for API routes.
 *
 * Centralizes validation logic used by multiple route handlers.
 *
 * This is the CANONICAL location for server-side validation schemas.
 * - Route handlers import schemas and helpers (parseBody, parseJsonBody) from here.
 * - Client-side parsing utilities live in `src/lib/api/validation.ts` (parseBody, parseQuery
 *   returning Result types for use outside Hono handlers).
 * - `src/lib/api/schemas.ts` re-exports and extends schemas for client/shared use.
 *   Where schemas overlap, schemas.ts should import from here rather than redefine.
 */

import { z } from 'zod';

/** Safe CUID2 / kebab-case identifier */
export const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);

/** Task column enum */
export const taskColumnSchema = z.enum([
  'backlog',
  'queued',
  'in_progress',
  'waiting_approval',
  'verified',
]);

/** Task priority enum */
export const taskPrioritySchema = z.enum(['high', 'medium', 'low']);

// ─── Task Schemas ────────────────────────────────────

/** Filesystem-safe skill ID: alphanumeric + hyphens + underscores */
const skillIdSchema = z
  .string()
  .max(200)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    'Skill ID must contain only alphanumeric characters, hyphens, and underscores'
  );

const approvalModeSchema = z.enum(['human', 'agent']);

export const createTaskSchema = z.object({
  codespaceId: idSchema,
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().max(10000).optional(),
  labels: z.array(z.string().max(50)).max(20).optional(),
  priority: taskPrioritySchema.optional(),
  skillId: skillIdSchema.optional(),
  skillName: z.string().max(200).optional(),
  executionSkillId: skillIdSchema.optional(),
  executionSkillName: z.string().max(200).optional(),
  approvalMode: approvalModeSchema.optional(),
  autoStart: z.boolean().optional(),
});

export const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).optional(),
    labels: z.array(z.string().max(50)).max(20).optional(),
    priority: taskPrioritySchema.optional(),
    skillId: skillIdSchema.nullable().optional(),
    skillName: z.string().max(200).nullable().optional(),
    executionSkillId: skillIdSchema.nullable().optional(),
    executionSkillName: z.string().max(200).nullable().optional(),
    approvalMode: approvalModeSchema.nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export const moveTaskSchema = z.object({
  column: taskColumnSchema,
  position: z.number().int().min(0).optional(),
  startAgent: z.boolean().optional(),
});

// ─── Agent Schemas ───────────────────────────────────

export const agentTypeSchema = z.enum(['task', 'conversational', 'background']);

export const createAgentSchema = z.object({
  codespaceId: idSchema,
  name: z.string().min(1, 'Name is required').max(200),
  type: agentTypeSchema,
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for `PATCH /api/agents/:id` — accepts either a flat AgentConfig shape
 * (`{ allowedTools, maxTurns, ... }`) or a wrapped variant (`{ config: {...} }`).
 * The existing route accepts both forms; both are validated to bound string
 * lengths, array sizes, and number ranges.
 */
const agentConfigFieldsSchema = z
  .object({
    allowedTools: z.array(z.string().max(200)).max(200).optional(),
    maxTurns: z.number().int().min(1).max(1000).optional(),
    model: z.string().max(200).optional(),
    systemPrompt: z.string().max(20000).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .partial();

export const updateAgentSchema = agentConfigFieldsSchema
  .extend({
    config: agentConfigFieldsSchema.optional(),
  })
  .refine(
    (data) => {
      const { config, ...rest } = data;
      return (
        (config && Object.keys(config).length > 0) ||
        Object.values(rest).some((v) => v !== undefined)
      );
    },
    { message: 'config is required' }
  );

/** Schema for `POST /api/agents/:id/start` — only optional taskId for now. */
export const agentStartSchema = z
  .object({
    taskId: idSchema.optional(),
  })
  .strict();

/** Schema for `POST /api/agents/:id/resume` — feedback bounded to 10000 chars. */
export const agentResumeSchema = z
  .object({
    feedback: z.string().max(10000).optional(),
  })
  .strict();

// ─── Session Schemas ─────────────────────────────────

export const createSessionSchema = z.object({
  codespaceId: idSchema,
  taskId: idSchema.optional(),
  agentId: idSchema.optional(),
  title: z.string().max(500).optional(),
});

export const exportSessionSchema = z.object({
  format: z.enum(['json', 'markdown', 'csv']),
});

// ─── RBAC Schemas ─────────────────────────────────────

export const rbacRoleSchema = z.enum(['owner', 'admin', 'agent_operator', 'viewer']);

/** Role schema that excludes 'owner' -- used for assignable roles */
const assignableRoleSchema = z.enum(['admin', 'agent_operator', 'viewer']);

export const createTeamSchema = z.object({
  name: z.string().min(1, 'Team name is required').max(100),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      'Slug must start and end with alphanumeric, hyphens allowed between'
    )
    .optional(),
  description: z.string().max(500).optional(),
});

export const updateTeamSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        'Slug must start and end with alphanumeric, hyphens allowed between'
      )
      .optional(),
    description: z.string().max(500).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export const addTeamMemberSchema = z.object({
  userId: idSchema,
  role: assignableRoleSchema,
});

export const updateTeamMemberSchema = z.object({
  role: assignableRoleSchema,
});

export const createInvitationSchema = z.object({
  email: z.string().max(254).email('Valid email is required'),
  role: assignableRoleSchema,
});

export const addProjectMemberSchema = z.object({
  userId: idSchema,
  role: assignableRoleSchema,
  teamId: idSchema.optional(),
});

export const updateProjectMemberSchema = z.object({
  role: assignableRoleSchema,
});

export const createApiTokenSchema = z.object({
  name: z.string().min(1, 'Token name is required').max(100),
  teamId: idSchema,
  role: assignableRoleSchema,
  scopeTags: z.array(z.string().min(1).max(50).trim()).max(20).optional(),
  scopeCodespaceId: idSchema.optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const createTagSchema = z.object({
  projectFolderId: idSchema,
  name: z.string().min(1, 'Tag name is required').max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex code')
    .optional(),
});

export const assignTagSchema = z.object({
  tagId: idSchema,
});

export const transferOwnershipSchema = z.object({
  targetUserId: idSchema,
});

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().max(254).email().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

// ─── Codespace Schemas ───────────────────────────────

export const createCodespaceSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  path: z.string().min(1, 'Path is required').max(2048),
  description: z.string().max(2000).optional(),
  projectFolderId: idSchema,
});

export const updateCodespaceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    maxConcurrentAgents: z.number().int().positive().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    projectFolderId: idSchema.optional(),
    githubOwner: z.string().min(1).max(200).optional(),
    githubRepo: z.string().min(1).max(200).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

// ─── Template Schemas ────────────────────────────────

export const createTemplateSchema = z.object({
  name: z.string().min(1, 'name is required').max(200),
  description: z.string().max(2000).optional(),
  scope: z.enum(['org', 'codespace'], {
    message: 'scope must be "org" or "codespace"',
  }),
  githubUrl: z
    .string({ message: 'githubUrl is required' })
    .min(1, 'githubUrl is required')
    .max(1000),
  branch: z.string().max(200).optional(),
  configPath: z.string().max(500).optional(),
  codespaceId: idSchema.optional(),
  codespaceIds: z.array(idSchema).max(100).optional(),
});

export const updateTemplateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    branch: z.string().max(200).optional(),
    configPath: z.string().max(500).optional(),
    codespaceIds: z.array(idSchema).max(100).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

// ─── Marketplace Schemas ─────────────────────────────

export const createMarketplaceSchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(200),
    githubUrl: z.string().max(1000).optional(),
    githubOwner: z.string().max(200).optional(),
    githubRepo: z.string().max(200).optional(),
    branch: z.string().max(200).optional(),
    pluginsPath: z.string().max(500).optional(),
  })
  .refine((data) => Boolean(data.githubUrl) || Boolean(data.githubOwner && data.githubRepo), {
    message: 'GitHub URL or owner/repo required',
  });

// ─── API Key Schemas ─────────────────────────────────

export const saveApiKeySchema = z.object({
  key: z.string().min(1, 'API key is required').max(10000),
});

// ─── Settings Schemas ────────────────────────────────

export const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

// ─── Memory Schemas ──────────────────────────────────

export const createMemoryInsightSchema = z.object({
  content: z.string().min(1).max(4096),
  source: z.enum(['manual', 'agent_derived', 'dream']).optional().default('manual'),
  skillId: z.string().max(200).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  category: z
    .enum(['pattern', 'anti_pattern', 'decision', 'architecture', 'error_lesson'])
    .optional(),
});

export const memorySearchSchema = z.object({
  query: z.string().min(1).max(1024),
  limit: z.number().min(1).max(50).optional(),
});

export const memorySuggestionActionSchema = z.object({
  userNotes: z.string().max(10000).optional(),
});

export const memoryModifySuggestionSchema = z.object({
  modifiedContent: z.string().min(1).max(50000),
  userNotes: z.string().max(10000).optional(),
});

/**
 * Per-skill dream config override. The `null` case (clear-override) is handled
 * outside zod because zod cannot represent JSON `null` as a top-level body.
 */
export const dreamSkillOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().max(200).optional(),
    minRuns: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .optional();

// ─── Task action body schemas ────────────────────────

export const rejectPlanSchema = z
  .object({
    reason: z.string().max(10000).optional(),
  })
  .strict()
  .optional();

export const approveTaskSchema = z
  .object({
    approvedBy: z.string().max(200).optional(),
    createMergeCommit: z.boolean().optional(),
  })
  .strict()
  .optional();

export const rejectTaskSchema = z.object({
  reason: z
    .string()
    .min(1, 'A non-empty "reason" field is required when rejecting a task')
    .max(10000)
    .refine((v) => v.trim() !== '', {
      message: 'A non-empty "reason" field is required when rejecting a task',
    }),
});

// ─── Terraform Schemas (validate body) ───────────────

export const terraformValidateSchema = z.object({
  code: z.string().min(1, 'code field is required').max(500_000),
  tfvars: z.string().max(500_000).optional(),
});

// ─── Workflow update schema (PATCH) ──────────────────

export const workflowStatusUpdateSchema = z.enum(['draft', 'published', 'archived']);

export const updateWorkflowSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    nodes: z.array(z.unknown()).optional(),
    edges: z.array(z.unknown()).optional(),
    viewport: z
      .object({
        x: z.number(),
        y: z.number(),
        zoom: z.number(),
      })
      .optional(),
    status: workflowStatusUpdateSchema.optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    sourceTemplateId: z.string().nullable().optional(),
    sourceTemplateName: z.string().max(200).nullable().optional(),
    thumbnail: z.string().max(5000).nullable().optional(),
    aiGenerated: z.boolean().optional(),
    aiModel: z.string().max(200).nullable().optional(),
    aiConfidence: z.number().min(0).max(100).nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

// ─── Sandbox Nomad Schemas ───────────────────────────

export const sandboxNomadValidateSchema = z.object({
  address: z.string().min(1, 'Nomad address is required').max(2048),
  token: z.string().max(2048).optional(),
  namespace: z.string().max(200).optional(),
});

// ─── Helper ──────────────────────────────────────────

type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

function validationError(message: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: new Response(
      JSON.stringify({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    ),
  };
}

/**
 * Parse a Zod schema and return a validation error response or the parsed data.
 *
 * @returns `{ ok: true, data }` or `{ ok: false, response }` where `response` is
 * a JSON Response ready to return from the handler.
 */
export function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): ParseResult<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    return validationError(result.error.issues[0]?.message ?? 'Invalid request body');
  }
  return { ok: true, data: result.data };
}

/**
 * Parse JSON from a Hono request context and validate against a Zod schema.
 * Combines JSON parsing and schema validation into one step.
 *
 * @returns `{ ok: true, data }` or `{ ok: false, response }` where `response` is
 * a JSON Response ready to return from the handler.
 */
export async function parseJsonBody<T>(
  c: { req: { json(): Promise<unknown> } },
  schema: z.ZodSchema<T>
): Promise<ParseResult<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return validationError('Invalid JSON');
    }
    // Unexpected error (stream error, body too large, etc.)
    return validationError('Failed to read request body');
  }
  return parseBody(schema, body);
}
