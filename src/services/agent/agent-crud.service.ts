import { and, count, desc, eq } from 'drizzle-orm';
import type { Agent, AgentConfig, NewAgent } from '../../db/schema';
import { agents, projects } from '../../db/schema';
import type { AgentError } from '../../lib/errors/agent-errors.js';
import { AgentErrors } from '../../lib/errors/agent-errors.js';
import type { ValidationError } from '../../lib/errors/validation-errors.js';
import { ValidationErrors } from '../../lib/errors/validation-errors.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';

/**
 * AgentCrudService handles CRUD operations for agents.
 *
 * Responsibilities:
 * - Create new agents with project config defaults
 * - Get agent by ID
 * - List agents by project or all
 * - Update agent configuration
 * - Delete agents
 * - Get running count for all agents
 */
export class AgentCrudService {
  constructor(private db: Database) {}

  /**
   * Create a new agent with configuration defaults from the project.
   */
  async create(input: NewAgent): Promise<Result<Agent, ValidationError>> {
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, input.projectId),
    });

    if (!project) {
      return err(ValidationErrors.INVALID_ID('projectId'));
    }

    const config: AgentConfig = {
      allowedTools: input.config?.allowedTools ?? project.config?.allowedTools ?? [],
      maxTurns: input.config?.maxTurns ?? project.config?.maxTurns ?? 50,
      model: input.config?.model ?? project.config?.model,
      systemPrompt: input.config?.systemPrompt ?? project.config?.systemPrompt,
      temperature: input.config?.temperature ?? project.config?.temperature,
    };

    const [agent] = await this.db
      .insert(agents)
      .values({
        ...input,
        config,
      })
      .returning();

    return ok(agent as Agent);
  }

  /**
   * Get an agent by ID.
   */
  async getById(id: string): Promise<Result<Agent, AgentError>> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, id),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    return ok(agent);
  }

  /**
   * List agents for a specific project, ordered by most recently updated.
   */
  async list(projectId: string): Promise<Result<Agent[], never>> {
    const items = await this.db.query.agents.findMany({
      where: eq(agents.projectId, projectId),
      orderBy: [desc(agents.updatedAt)],
    });

    return ok(items);
  }

  /**
   * List all agents across all projects, ordered by most recently updated.
   */
  async listAll(): Promise<Result<Agent[], never>> {
    const items = await this.db.query.agents.findMany({
      orderBy: [desc(agents.updatedAt)],
    });

    return ok(items);
  }

  /**
   * Get the count of all running agents across all projects.
   */
  async getRunningCountAll(): Promise<Result<number, never>> {
    const [result] = await this.db
      .select({ count: count() })
      .from(agents)
      .where(eq(agents.status, 'running'));
    return ok(result?.count ?? 0);
  }

  /**
   * Get the count of running agents for a specific project.
   */
  async getRunningCount(projectId: string): Promise<Result<number, never>> {
    const [result] = await this.db
      .select({ count: count() })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.status, 'running')));
    return ok(result?.count ?? 0);
  }

  /**
   * Update an agent's configuration.
   * Prevents updating critical config (allowedTools, model) while agent is running.
   */
  async update(
    id: string,
    input: Partial<AgentConfig>
  ): Promise<Result<Agent, AgentError | ValidationError>> {
    const existing = await this.getById(id);
    if (!existing.ok) {
      return existing;
    }

    if (existing.value.status === 'running') {
      if (input.allowedTools || input.model) {
        return err(AgentErrors.ALREADY_RUNNING(existing.value.currentTaskId ?? undefined));
      }
    }

    const mergedConfig: AgentConfig = {
      allowedTools: input.allowedTools ?? existing.value.config?.allowedTools ?? [],
      maxTurns: input.maxTurns ?? existing.value.config?.maxTurns ?? 50,
      model: input.model ?? existing.value.config?.model,
      systemPrompt: input.systemPrompt ?? existing.value.config?.systemPrompt,
      temperature: input.temperature ?? existing.value.config?.temperature,
    };

    const [updated] = await this.db
      .update(agents)
      .set({ config: mergedConfig, updatedAt: new Date().toISOString() })
      .where(eq(agents.id, id))
      .returning();

    if (!updated) {
      return err(AgentErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  /**
   * Delete an agent by ID.
   */
  async delete(id: string): Promise<Result<void, AgentError>> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, id),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    await this.db.delete(agents).where(eq(agents.id, id));
    return ok(undefined);
  }
}
